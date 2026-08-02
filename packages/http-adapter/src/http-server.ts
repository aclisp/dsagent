import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import {
  HttpUiResponseError,
  type HttpUiBroker,
  type HttpUiBrokerEvent,
  type HttpUiBrokerListener,
  type HttpUiEvent,
  type HttpUiRequest,
  type HttpUiResponse,
} from "./ui-broker.js";

export interface HttpAdapterServerHost {
  readonly session: {
    getLastAssistantText(): string | undefined;
  };
  readonly uiBroker: Pick<HttpUiBroker, "respond">;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(listener: HttpUiBrokerListener): () => void;
  dispose(): Promise<void>;
}

export type HttpTurnStatus =
  | "running"
  | "aborting"
  | "completed"
  | "failed"
  | "aborted";

export type HttpAdapterEvent =
  | {
      type: "turn";
      turnId: string;
      status: HttpTurnStatus;
      output?: string | null;
    }
  | { type: "assistant_text_delta"; turnId: string | null; delta: string }
  | {
      type: "tool";
      turnId: string | null;
      phase: "started";
      toolCallId: string;
      name: string;
      args: unknown;
    }
  | {
      type: "tool";
      turnId: string | null;
      phase: "updated";
      toolCallId: string;
      name: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool";
      turnId: string | null;
      phase: "completed";
      toolCallId: string;
      name: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "ui_request"; turnId: string | null; request: HttpUiRequest }
  | { type: "ui_event"; turnId: string | null; event: HttpUiEvent }
  | {
      type: "extension_error";
      turnId: string | null;
      error: { extensionPath: string; event: string; message: string };
    };

interface TurnBody {
  message: string;
}

interface TurnParams {
  turnId: string;
}

interface UiResponseParams {
  requestId: string;
}

type UiResponseBody =
  | { confirmed: boolean }
  | { value: string }
  | { cancelled: true };

interface AbortAttempt {
  ok: boolean;
  error?: unknown;
}

interface ActiveTurn {
  id: string;
  abortAttempt?: Promise<AbortAttempt>;
}

const turnBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1 },
  },
} as const;

const uiResponseBodySchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["confirmed"],
      properties: { confirmed: { type: "boolean" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["cancelled"],
      properties: { cancelled: { const: true } },
    },
  ],
} as const;

export function createHttpAdapterServer(host: HttpAdapterServerHost): FastifyInstance {
  const server = Fastify({
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });
  const eventStreams = new Map<ServerResponse, () => void>();
  let activeTurn: ActiveTurn | undefined;
  let latestTurnEvent: Extract<HttpAdapterEvent, { type: "turn" }> | undefined;

  const closeEventStream = (response: ServerResponse): void => {
    eventStreams.get(response)?.();
    eventStreams.delete(response);
  };

  const writeEvent = (response: ServerResponse, event: HttpAdapterEvent): void => {
    if (response.destroyed || response.writableEnded) {
      closeEventStream(response);
      return;
    }
    try {
      const writable = response.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
      if (!writable) {
        closeEventStream(response);
        response.end();
      }
    } catch {
      closeEventStream(response);
      response.destroy();
    }
  };

  const publish = (event: HttpAdapterEvent): void => {
    for (const response of eventStreams.keys()) writeEvent(response, event);
  };

  const publishTurn = (
    turnId: string,
    status: HttpTurnStatus,
    output?: string | null,
  ): void => {
    const event: Extract<HttpAdapterEvent, { type: "turn" }> = {
      type: "turn",
      turnId,
      status,
      ...(output !== undefined ? { output } : {}),
    };
    latestTurnEvent = event;
    publish(event);
  };

  const translateBrokerEvent = (
    brokerEvent: HttpUiBrokerEvent,
  ): HttpAdapterEvent | undefined => {
    const turnId = activeTurn?.id ?? null;
    if (brokerEvent.type === "ui_request") {
      return { type: "ui_request", turnId, request: brokerEvent.request };
    }
    if (brokerEvent.type === "ui_event") {
      return { type: "ui_event", turnId, event: brokerEvent.event };
    }
    if (brokerEvent.type === "extension_error") {
      return {
        type: "extension_error",
        turnId,
        error: {
          extensionPath: brokerEvent.error.extensionPath,
          event: brokerEvent.error.event,
          message: brokerEvent.error.error,
        },
      };
    }

    const event = brokerEvent.event;
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      return {
        type: "assistant_text_delta",
        turnId,
        delta: event.assistantMessageEvent.delta,
      };
    }
    if (event.type === "tool_execution_start") {
      return {
        type: "tool",
        turnId,
        phase: "started",
        toolCallId: event.toolCallId,
        name: event.toolName,
        args: event.args,
      };
    }
    if (event.type === "tool_execution_update") {
      return {
        type: "tool",
        turnId,
        phase: "updated",
        toolCallId: event.toolCallId,
        name: event.toolName,
        args: event.args,
        partialResult: event.partialResult,
      };
    }
    if (event.type === "tool_execution_end") {
      return {
        type: "tool",
        turnId,
        phase: "completed",
        toolCallId: event.toolCallId,
        name: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    }
    return undefined;
  };

  server.get("/health", async () => ({ status: "ok" }));

  server.get("/v1/events", async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.flushHeaders();

    if (latestTurnEvent) writeEvent(response, latestTurnEvent);
    const unsubscribe = host.subscribe((brokerEvent) => {
      const event = translateBrokerEvent(brokerEvent);
      if (event) writeEvent(response, event);
    });
    eventStreams.set(response, unsubscribe);
    response.once("close", () => closeEventStream(response));
    request.raw.once("error", () => closeEventStream(response));
    return reply;
  });

  server.post<{ Body: TurnBody }>(
    "/v1/turns",
    { schema: { body: turnBodySchema } },
    async (request, reply) => {
      if (request.body.message.trim().length === 0) {
        return reply.code(400).send({ error: "invalid_message" });
      }
      if (activeTurn) {
        return reply.code(409).send({ error: "turn_in_progress" });
      }

      const turn: ActiveTurn = { id: randomUUID() };
      const message = request.body.message;
      const log = request.log;
      activeTurn = turn;
      publishTurn(turn.id, "running");

      void (async () => {
        let failed = false;
        let failure: unknown;
        try {
          await host.prompt(message);
          await host.waitForIdle();
        } catch (error) {
          failed = true;
          failure = error;
        }

        const abortResult = turn.abortAttempt
          ? await turn.abortAttempt
          : undefined;
        if (abortResult?.ok) {
          publishTurn(turn.id, "aborted");
        } else if (failed) {
          log.error({ err: failure, turnId: turn.id }, "Agent turn failed");
          publishTurn(turn.id, "failed");
        } else {
          try {
            publishTurn(
              turn.id,
              "completed",
              host.session.getLastAssistantText() ?? null,
            );
          } catch (error) {
            log.error({ err: error, turnId: turn.id }, "Agent turn failed");
            publishTurn(turn.id, "failed");
          }
        }
        if (activeTurn === turn) activeTurn = undefined;
      })();

      return reply.code(202).send({ id: turn.id, status: "running" });
    },
  );

  server.post<{ Params: UiResponseParams; Body: UiResponseBody }>(
    "/v1/ui-requests/:requestId/responses",
    {
      schema: { body: uiResponseBodySchema },
      errorHandler(error, _request, reply) {
        if (error.validation) {
          return reply.code(400).send({ error: "invalid_ui_response" });
        }
        throw error;
      },
    },
    async (request, reply) => {
      const response = {
        requestId: request.params.requestId,
        ...request.body,
      } as HttpUiResponse;
      try {
        host.uiBroker.respond(response);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof HttpUiResponseError) {
          const code = error.code === "not_found" ? 404 : 400;
          const bodyError =
            error.code === "not_found"
              ? "ui_request_not_found"
              : "invalid_ui_response";
          return reply.code(code).send({ error: bodyError });
        }
        request.log.error({ err: error }, "UI response failed");
        return reply.code(500).send({ error: "ui_response_failed" });
      }
    },
  );

  server.post<{ Params: TurnParams }>(
    "/v1/turns/:turnId/abort",
    async (request, reply) => {
      const turn = activeTurn;
      if (!turn || turn.id !== request.params.turnId) {
        return reply.code(404).send({ error: "turn_not_found" });
      }
      if (!turn.abortAttempt) {
        publishTurn(turn.id, "aborting");
        turn.abortAttempt = host.abort().then<AbortAttempt, AbortAttempt>(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
      }

      const attempt = turn.abortAttempt;
      const result = await attempt;
      if (result.ok) {
        return reply.code(202).send({ id: turn.id, status: "aborting" });
      }

      request.log.error(
        { err: result.error, turnId: turn.id },
        "Agent turn abort failed",
      );
      if (activeTurn === turn && turn.abortAttempt === attempt) {
        delete turn.abortAttempt;
        publishTurn(turn.id, "running");
      }
      return reply.code(500).send({ error: "turn_abort_failed" });
    },
  );

  server.addHook("preClose", async () => {
    for (const response of eventStreams.keys()) {
      closeEventStream(response);
      response.end();
    }
  });

  server.addHook("onClose", async () => {
    try {
      await host.abort();
    } finally {
      await host.dispose();
    }
  });

  return server;
}
