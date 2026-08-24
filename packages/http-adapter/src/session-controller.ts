import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SessionPortTurnEvent } from "./session-port.js";
import type { AgentMessage } from "./session-messages.js";
import type {
  HttpUiBroker,
  HttpUiBrokerEvent,
  HttpUiBrokerListener,
  HttpUiEvent,
  HttpUiRequest,
  HttpUiResponse,
} from "./ui-broker.js";

export interface HttpAdapterServerHost {
  readonly session: {
    readonly messages: readonly AgentMessage[];
  };
  readonly uiBroker: Pick<HttpUiBroker, "respond">;
  prompt(message: string): Promise<string | undefined>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  prunePersistedSession?(): boolean;
  subscribe(listener: HttpUiBrokerListener): () => void;
  dispose(): Promise<void>;
}

export type HttpSessionStatus = "idle" | "running" | "aborting";

export interface HttpSessionDescriptor {
  id: string;
  workspaceId: string;
  persisted: true;
  status: HttpSessionStatus;
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
      error?: string;
      message?: string;
      clientId?: string;
    }
  | { type: "assistant_text_delta"; turnId: string | null; delta: string }
  | { type: "thinking_start"; turnId: string | null }
  | { type: "thinking_end"; turnId: string | null }
  | { type: "compaction_start"; turnId: string | null }
  | { type: "compaction_end"; turnId: string | null }
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

export interface SessionControllerLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

interface AbortAttempt {
  ok: boolean;
  error?: unknown;
}

interface ActiveTurn {
  id: string;
  clientId?: string;
  abortAttempt?: Promise<AbortAttempt>;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const KEEPALIVE_INTERVAL_MS = 30_000;

export class SessionController {
  private readonly eventStreams = new Map<ServerResponse, () => void>();
  private activeTurn: ActiveTurn | undefined;
  private latestTurnEvent:
    | Extract<HttpAdapterEvent, { type: "turn" }>
    | undefined;
  private disposePromise: Promise<void> | undefined;
  private readonly unsubscribeHeadlessUiFallback: () => void;

  constructor(
    readonly id: string,
    readonly workspaceId: string,
    private readonly host: HttpAdapterServerHost,
    private readonly log: SessionControllerLogger,
    private readonly publishTerminalTurn: (event: SessionPortTurnEvent) => void,
  ) {
    this.unsubscribeHeadlessUiFallback = host.subscribe((event) => {
      if (
        event.type !== "ui_request" ||
        this.activeTurn === undefined ||
        this.activeTurn.clientId !== undefined
      ) {
        return;
      }
      try {
        host.uiBroker.respond(
          event.request.method === "confirm"
            ? { requestId: event.request.id, confirmed: false }
            : { requestId: event.request.id, cancelled: true },
        );
      } catch (error) {
        this.log.error(
          { err: error, turnId: this.activeTurn.id },
          "Headless UI request fallback failed",
        );
      }
    });
  }

  get descriptor(): HttpSessionDescriptor {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      persisted: true,
      status: this.activeTurn
        ? this.activeTurn.abortAttempt
          ? "aborting"
          : "running"
        : "idle",
    };
  }

  get messages(): readonly AgentMessage[] {
    return this.host.session.messages;
  }

  private closeEventStream(response: ServerResponse): void {
    this.eventStreams.get(response)?.();
    this.eventStreams.delete(response);
  }

  private writeEvent(response: ServerResponse, event: HttpAdapterEvent): void {
    if (response.destroyed || response.writableEnded) {
      this.closeEventStream(response);
      return;
    }
    try {
      const writable = response.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
      if (!writable) {
        this.closeEventStream(response);
        response.end();
      }
    } catch {
      this.closeEventStream(response);
      response.destroy();
    }
  }

  private publish(event: HttpAdapterEvent): void {
    for (const response of this.eventStreams.keys()) {
      this.writeEvent(response, event);
    }
  }

  private publishTurn(
    turnId: string,
    status: HttpTurnStatus,
    extras: {
      output?: string | null;
      error?: string;
      message?: string;
      clientId?: string;
    } = {},
  ): void {
    const event: Extract<HttpAdapterEvent, { type: "turn" }> = {
      type: "turn",
      turnId,
      status,
      ...(extras.output !== undefined ? { output: extras.output } : {}),
      ...(extras.error !== undefined ? { error: extras.error } : {}),
      ...(extras.message !== undefined ? { message: extras.message } : {}),
      ...(extras.clientId !== undefined ? { clientId: extras.clientId } : {}),
    };
    this.latestTurnEvent = event;
    this.publish(event);
    if (status === "completed") {
      this.publishTerminalTurn({
        status,
        turnId,
        output: extras.output ?? null,
      });
    } else if (status === "failed" || status === "aborted") {
      this.publishTerminalTurn({ status, turnId });
    }
  }

  private translateBrokerEvent(
    brokerEvent: HttpUiBrokerEvent,
  ): HttpAdapterEvent | undefined {
    const turnId = this.activeTurn?.id ?? null;
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
    if (event.type === "message_update") {
      const messageEvent = event.assistantMessageEvent;
      if (messageEvent.type === "text_delta") {
        return {
          type: "assistant_text_delta",
          turnId,
          delta: messageEvent.delta,
        };
      }
      if (messageEvent.type === "thinking_start") {
        return { type: "thinking_start", turnId };
      }
      if (messageEvent.type === "thinking_end") {
        return { type: "thinking_end", turnId };
      }
      return undefined;
    }
    if (event.type === "compaction_start") {
      return { type: "compaction_start", turnId };
    }
    if (event.type === "compaction_end") {
      return { type: "compaction_end", turnId };
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
  }

  openEventStream(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    reply.hijack();
    const response = reply.raw;
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) response.setHeader(name, value);
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.flushHeaders();

    if (this.latestTurnEvent) this.writeEvent(response, this.latestTurnEvent);
    const unsubscribe = this.host.subscribe((brokerEvent) => {
      const event = this.translateBrokerEvent(brokerEvent);
      if (event) this.writeEvent(response, event);
    });
    const keepalive = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) {
        response.write("event: ping\ndata: {}\n\n");
      }
    }, KEEPALIVE_INTERVAL_MS);
    this.eventStreams.set(response, () => {
      clearInterval(keepalive);
      unsubscribe();
    });
    response.once("close", () => this.closeEventStream(response));
    request.raw.once("error", () => this.closeEventStream(response));
    return reply;
  }

  startTurn(
    message: string,
    clientId: string | undefined,
  ): { id: string; status: "running" } | undefined {
    if (this.activeTurn) return undefined;

    const turn: ActiveTurn = {
      id: randomUUID(),
      ...(clientId !== undefined ? { clientId } : {}),
    };
    this.activeTurn = turn;
    // The running event carries the submission so every attached client can render
    // the user line; the submitter recognizes itself via clientId.
    this.publishTurn(turn.id, "running", {
      message,
      ...(clientId !== undefined ? { clientId } : {}),
    });

    // Give Session Port callers a microtask checkpoint to associate the accepted
    // turnId before even a synchronously failing Host can publish a terminal event.
    queueMicrotask(() => {
      queueMicrotask(() => {
        void (async () => {
          let failed = false;
          let failure: unknown;
          let output: string | undefined;
          try {
            output = await this.host.prompt(message);
            await this.host.waitForIdle();
          } catch (error) {
            failed = true;
            failure = error;
          }

          const abortResult = turn.abortAttempt
            ? await turn.abortAttempt
            : undefined;
          if (abortResult?.ok) {
            this.publishTurn(turn.id, "aborted");
          } else if (failed) {
            this.log.error({ err: failure, turnId: turn.id }, "Agent turn failed");
            this.publishTurn(turn.id, "failed", { error: failureMessage(failure) });
          } else {
            try {
              this.publishTurn(turn.id, "completed", {
                output: output ?? null,
              });
            } catch (error) {
              this.log.error({ err: error, turnId: turn.id }, "Agent turn failed");
              this.publishTurn(turn.id, "failed", {
                error: failureMessage(error),
              });
            }
          }
          // Prune before releasing activeTurn so no new turn can append to the file
          // while it is being rewritten.
          try {
            this.host.prunePersistedSession?.();
          } catch (error) {
            this.log.error(
              { err: error, turnId: turn.id },
              "Session file pruning failed",
            );
          }
          if (this.activeTurn === turn) this.activeTurn = undefined;
        })();
      });
    });

    return { id: turn.id, status: "running" };
  }

  respond(response: HttpUiResponse): void {
    this.host.uiBroker.respond(response);
  }

  async abortTurn(
    turnId: string,
  ): Promise<"not_found" | "aborting" | "failed"> {
    const turn = this.activeTurn;
    if (!turn || turn.id !== turnId) return "not_found";

    if (!turn.abortAttempt) {
      this.publishTurn(turn.id, "aborting");
      turn.abortAttempt = this.host.abort().then<AbortAttempt, AbortAttempt>(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
    }

    const attempt = turn.abortAttempt;
    const result = await attempt;
    if (result.ok) return "aborting";

    this.log.error(
      { err: result.error, turnId: turn.id },
      "Agent turn abort failed",
    );
    if (this.activeTurn === turn && turn.abortAttempt === attempt) {
      delete turn.abortAttempt;
      // No extras: re-sending the submission would make clients re-render it.
      this.publishTurn(turn.id, "running");
    }
    return "failed";
  }

  closeEventStreams(): void {
    for (const response of this.eventStreams.keys()) {
      this.closeEventStream(response);
      response.end();
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    const attempt = (async () => {
      this.closeEventStreams();
      this.unsubscribeHeadlessUiFallback();
      try {
        await this.host.abort();
      } finally {
        await this.host.dispose();
      }
    })();
    this.disposePromise = attempt;
    void attempt.catch(() => {
      if (this.disposePromise === attempt) this.disposePromise = undefined;
    });
    return attempt;
  }
}
