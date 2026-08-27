import { randomUUID } from "node:crypto";
import path from "node:path";
import cors from "@fastify/cors";
import Fastify, {
  type FastifyInstance,
  type FastifyLoggerOptions,
} from "fastify";
import {
  PersistedSessionAlreadyExistsError,
  PersistedSessionNotFoundError,
  createAgentSessionHost,
  listPersistedSessions,
  type PersistedSessionSummary,
} from "./agent-session-host.js";
import {
  SessionController,
  type HttpAdapterServerHost,
  type HttpSessionDescriptor,
} from "./session-controller.js";
import type {
  SessionPort,
  SessionPortTurnEvent,
  SessionPortTurnListener,
} from "./session-port.js";
import { toHttpSessionMessages } from "./session-messages.js";
import {
  HttpUiResponseError,
  type HttpUiResponse,
} from "./ui-broker.js";

export interface HttpAdapterHostFactoryOptions {
  cwd: string;
  runtimeArgs?: readonly string[];
  maxSessionFileBytes?: number;
  session:
    | { type: "persistent"; id: string }
    | { type: "resume"; id: string };
}

export type HttpAdapterHostFactory = (
  options: HttpAdapterHostFactoryOptions,
) => Promise<HttpAdapterServerHost>;

export type PersistedSessionLister = (
  cwd: string,
) => Promise<PersistedSessionSummary[]>;

export interface CreateHttpAdapterServerOptions {
  workspaces: Readonly<Record<string, string>>;
  runtimeArgs?: readonly string[];
  maxSessionFileBytes?: number;
  createHost?: HttpAdapterHostFactory;
  listPersistedSessions?: PersistedSessionLister;
  /** Require ?workspaceId= on GET /v1/sessions and return only that workspace. */
  requireWorkspaceIdForSessionList?: boolean;
  /** Browser origins allowed to call /health and routes under /v1; omitted disables CORS. */
  corsOrigins?: readonly string[];
  logger?: boolean | FastifyLoggerOptions;
}

export interface HttpAdapter {
  server: FastifyInstance;
  sessionPort: SessionPort;
}

export type HttpSessionListEntry =
  | { workspaceId: string; active: true; session: HttpSessionDescriptor }
  | { workspaceId: string; active: false; session: PersistedSessionSummary | null };

interface CreateSessionBody {
  workspaceId: string;
  resumeSessionId?: string;
}

interface SessionParams {
  sessionId: string;
}

interface TurnBody {
  message: string;
  clientId?: string;
}

interface TurnParams extends SessionParams {
  turnId: string;
}

interface UiResponseParams extends SessionParams {
  requestId: string;
}

type UiResponseBody =
  | { confirmed: boolean }
  | { value: string }
  | { cancelled: true };

const createSessionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["workspaceId"],
  properties: {
    workspaceId: { type: "string", minLength: 1 },
    resumeSessionId: { type: "string", minLength: 1 },
  },
} as const;

const turnBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1 },
    clientId: { type: "string", minLength: 1 },
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

const CORS_METHODS = ["GET", "HEAD", "POST", "DELETE", "OPTIONS"];
const CORS_ALLOWED_HEADERS = ["Content-Type", "Accept"];
const CORS_MAX_AGE_SECONDS = 600;

function normalizeCorsOrigins(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  const origins = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0) throw new Error("CORS origins must not contain blank entries");
    if (value === "*") throw new Error("CORS wildcard origin is not allowed");

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Invalid CORS origin: ${value}`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin !== value
    ) {
      throw new Error(`CORS origin must be an exact HTTP(S) origin: ${value}`);
    }
    origins.add(value);
  }
  return [...origins];
}

function isCorsApiRequest(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? "";
  return pathname === "/health" || pathname.startsWith("/v1/");
}

export function createHttpAdapter(
  options: CreateHttpAdapterServerOptions,
): HttpAdapter {
  const corsOrigins = normalizeCorsOrigins(options.corsOrigins);
  const server = Fastify({
    logger: options.logger ?? false,
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });
  if (corsOrigins.length > 0) {
    server.register(cors, {
      delegator(request, callback) {
        if (!isCorsApiRequest(request.url)) {
          callback(null, { origin: false });
          return;
        }
        callback(null, {
          origin: corsOrigins,
          methods: CORS_METHODS,
          allowedHeaders: CORS_ALLOWED_HEADERS,
          credentials: false,
          maxAge: CORS_MAX_AGE_SECONDS,
        });
      },
    });
  }
  const workspaces = new Map<string, string>();
  for (const [id, cwd] of Object.entries(options.workspaces)) {
    if (id.trim().length === 0) throw new Error("Workspace ID must not be blank");
    if (cwd.trim().length === 0) throw new Error(`Workspace path is blank: ${id}`);
    workspaces.set(id, path.resolve(cwd));
  }

  const createHost: HttpAdapterHostFactory =
    options.createHost ??
    ((hostOptions) => createAgentSessionHost(hostOptions));
  const listSessions: PersistedSessionLister =
    options.listPersistedSessions ?? listPersistedSessions;
  const sessions = new Map<string, SessionController>();
  const disposingSessions = new Map<string, SessionController>();
  const activatingSessions = new Set<string>();
  const activatingWorkspaces = new Set<string>();
  const workspaceActivations = new Map<
    string,
    Promise<SessionController>
  >();
  const terminalTurnListeners = new Set<SessionPortTurnListener>();
  let closing = false;

  const getSession = (sessionId: string): SessionController | undefined =>
    sessions.get(sessionId);

  const getWorkspaceSession = (
    workspaceId: string,
    controllers: Iterable<SessionController> = sessions.values(),
  ): SessionController | undefined =>
    [...controllers].find(
      (controller) => controller.workspaceId === workspaceId,
    );

  const publishTerminalTurn = (event: SessionPortTurnEvent): void => {
    for (const listener of terminalTurnListeners) {
      try {
        const result = listener(event);
        if (result) {
          void result.catch((error: unknown) => {
            server.log.error(
              { err: error, turnId: event.turnId },
              "Session Port listener failed",
            );
          });
        }
      } catch (error) {
        server.log.error(
          { err: error, turnId: event.turnId },
          "Session Port listener failed",
        );
      }
    }
  };

  const createController = async (
    workspaceId: string,
    cwd: string,
    session: HttpAdapterHostFactoryOptions["session"],
  ): Promise<SessionController> => {
    const host = await createHost({
      cwd,
      session,
      ...(options.runtimeArgs !== undefined
        ? { runtimeArgs: options.runtimeArgs }
        : {}),
      ...(options.maxSessionFileBytes !== undefined
        ? { maxSessionFileBytes: options.maxSessionFileBytes }
        : {}),
    });
    const controller = new SessionController(
      session.id,
      workspaceId,
      host,
      server.log,
      publishTerminalTurn,
    );
    sessions.set(session.id, controller);
    return controller;
  };

  const activateSession = (
    workspaceId: string,
    cwd: string,
    session: HttpAdapterHostFactoryOptions["session"],
  ): Promise<SessionController> => {
    activatingSessions.add(session.id);
    activatingWorkspaces.add(workspaceId);
    let activation!: Promise<SessionController>;
    activation = (async () => {
      try {
        return await createController(workspaceId, cwd, session);
      } finally {
        activatingSessions.delete(session.id);
        activatingWorkspaces.delete(workspaceId);
        if (workspaceActivations.get(workspaceId) === activation) {
          workspaceActivations.delete(workspaceId);
        }
      }
    })();
    workspaceActivations.set(workspaceId, activation);
    return activation;
  };

  const activateWorkspace = async (
    workspaceId: string,
  ): Promise<SessionController> => {
    if (closing) throw new Error("HTTP adapter is closing");
    if (workspaceId.trim().length === 0) {
      throw new Error("Workspace ID must not be blank");
    }
    const cwd = workspaces.get(workspaceId);
    if (!cwd) throw new Error(`Workspace not found: ${workspaceId}`);

    const active = getWorkspaceSession(workspaceId);
    if (active) return active;
    const pending = workspaceActivations.get(workspaceId);
    if (pending) return pending;
    if (getWorkspaceSession(workspaceId, disposingSessions.values())) {
      throw new Error(`Workspace session is being disposed: ${workspaceId}`);
    }

    let sessionId: string | undefined;
    let activation!: Promise<SessionController>;
    activatingWorkspaces.add(workspaceId);
    activation = (async () => {
      try {
        const summaries = await listSessions(cwd);
        const latest = summaries[0];
        sessionId = latest?.id ?? randomUUID();
        if (
          sessions.has(sessionId) ||
          disposingSessions.has(sessionId) ||
          activatingSessions.has(sessionId)
        ) {
          throw new Error(`Session is already active: ${sessionId}`);
        }
        activatingSessions.add(sessionId);
        const session: HttpAdapterHostFactoryOptions["session"] = latest
          ? { type: "resume", id: sessionId }
          : { type: "persistent", id: sessionId };
        return await createController(workspaceId, cwd, session);
      } finally {
        if (sessionId !== undefined) activatingSessions.delete(sessionId);
        activatingWorkspaces.delete(workspaceId);
        if (workspaceActivations.get(workspaceId) === activation) {
          workspaceActivations.delete(workspaceId);
        }
      }
    })();
    workspaceActivations.set(workspaceId, activation);
    return activation;
  };

  const sessionPort: SessionPort = {
    async activate(workspaceId) {
      const controller = await activateWorkspace(workspaceId);
      return { sessionId: controller.id };
    },
    async submitTurn(workspaceId, message, context) {
      if (message.trim().length === 0) {
        throw new Error("Turn message must not be blank");
      }
      const controller = await activateWorkspace(workspaceId);
      const turn = controller.startTurn(message, undefined, context);
      return turn
        ? { status: "accepted", turnId: turn.id }
        : { status: "busy" };
    },
    subscribe(listener) {
      if (closing) throw new Error("HTTP adapter is closing");
      terminalTurnListeners.add(listener);
      return () => terminalTurnListeners.delete(listener);
    },
  };

  server.get("/health", async () => ({ status: "ok" }));

  server.get<{ Querystring: { workspaceId?: string } }>(
    "/v1/sessions",
    async (request, reply) => {
      const { workspaceId } = request.query;
      if (options.requireWorkspaceIdForSessionList && !workspaceId?.trim()) {
        return reply.code(400).send({ error: "invalid_session_request" });
      }
      const scope = workspaceId?.trim();
      const cwd = scope ? workspaces.get(scope) : undefined;
      if (scope && !cwd) return reply.code(404).send({ error: "workspace_not_found" });
      const targets: [string, string][] =
        scope && cwd ? [[scope, cwd]] : [...workspaces.entries()];
      const entries: HttpSessionListEntry[] = [];
      for (const [entryWorkspaceId, entryCwd] of targets) {
        const active = [...sessions.values(), ...disposingSessions.values()].find(
          (controller) => controller.workspaceId === entryWorkspaceId,
        );
        if (active) {
          entries.push({ workspaceId: entryWorkspaceId, active: true, session: active.descriptor });
          continue;
        }
        let summaries: PersistedSessionSummary[];
        try {
          summaries = await listSessions(entryCwd);
        } catch (error) {
          request.log.error(
            { err: error, workspaceId: entryWorkspaceId },
            "Persisted session listing failed",
          );
          return reply.code(500).send({ error: "session_list_failed" });
        }
        entries.push({ workspaceId: entryWorkspaceId, active: false, session: summaries[0] ?? null });
      }
      return { sessions: entries };
    },
  );

  server.post<{ Body: CreateSessionBody }>(
    "/v1/sessions",
    {
      schema: { body: createSessionBodySchema },
      errorHandler(error, _request, reply) {
        if (error.validation) {
          return reply.code(400).send({ error: "invalid_session_request" });
        }
        throw error;
      },
    },
    async (request, reply) => {
      const { workspaceId, resumeSessionId } = request.body;
      if (
        workspaceId.trim().length === 0 ||
        resumeSessionId?.trim().length === 0
      ) {
        return reply.code(400).send({ error: "invalid_session_request" });
      }

      const cwd = workspaces.get(workspaceId);
      if (!cwd) return reply.code(404).send({ error: "workspace_not_found" });

      const resumed = resumeSessionId !== undefined;
      const sessionId = resumeSessionId ?? randomUUID();
      if (
        sessions.has(sessionId) ||
        disposingSessions.has(sessionId) ||
        activatingSessions.has(sessionId)
      ) {
        return reply.code(409).send({ error: "session_already_active" });
      }

      const workspaceOccupied =
        activatingWorkspaces.has(workspaceId) ||
        [...sessions.values(), ...disposingSessions.values()].some(
          (controller) => controller.workspaceId === workspaceId,
        );
      if (workspaceOccupied) {
        return reply.code(409).send({ error: "workspace_session_active" });
      }

      try {
        const session: HttpAdapterHostFactoryOptions["session"] = resumed
          ? { type: "resume", id: sessionId }
          : { type: "persistent", id: sessionId };
        const controller = await activateSession(workspaceId, cwd, session);
        return reply.code(201).send({
          ...controller.descriptor,
          resumed,
        });
      } catch (error) {
        if (error instanceof PersistedSessionAlreadyExistsError) {
          return reply.code(409).send({ error: "session_already_exists" });
        }
        if (error instanceof PersistedSessionNotFoundError) {
          return reply
            .code(404)
            .send({ error: "persistent_session_not_found" });
        }
        request.log.error(
          { err: error, sessionId, workspaceId },
          "Agent session creation failed",
        );
        return reply.code(500).send({ error: "session_creation_failed" });
      }
    },
  );

  server.get<{ Params: SessionParams }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      const controller = getSession(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      return controller.descriptor;
    },
  );

  server.get<{ Params: SessionParams }>(
    "/v1/sessions/:sessionId/messages",
    async (request, reply) => {
      const controller = getSession(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      return { messages: toHttpSessionMessages(controller.messages) };
    },
  );

  server.delete<{ Params: SessionParams }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      const controller =
        getSession(request.params.sessionId) ??
        disposingSessions.get(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      if (sessions.delete(controller.id)) {
        disposingSessions.set(controller.id, controller);
      }
      try {
        await controller.dispose();
        disposingSessions.delete(controller.id);
        return reply.code(204).send();
      } catch (error) {
        request.log.error(
          { err: error, sessionId: controller.id },
          "Agent session disposal failed",
        );
        return reply.code(500).send({ error: "session_disposal_failed" });
      }
    },
  );

  server.get<{ Params: SessionParams }>(
    "/v1/sessions/:sessionId/events",
    async (request, reply) => {
      const controller = getSession(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      return controller.openEventStream(request, reply);
    },
  );

  server.post<{ Params: SessionParams; Body: TurnBody }>(
    "/v1/sessions/:sessionId/turns",
    { schema: { body: turnBodySchema } },
    async (request, reply) => {
      const controller = getSession(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      if (request.body.message.trim().length === 0) {
        return reply.code(400).send({ error: "invalid_message" });
      }

      const turn = controller.startTurn(
        request.body.message,
        request.body.clientId,
      );
      if (!turn) return reply.code(409).send({ error: "turn_in_progress" });
      return reply.code(202).send(turn);
    },
  );

  server.post<{ Params: UiResponseParams; Body: UiResponseBody }>(
    "/v1/sessions/:sessionId/ui-requests/:requestId/responses",
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
      const controller = getSession(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const response = {
        requestId: request.params.requestId,
        ...request.body,
      } as HttpUiResponse;
      try {
        controller.respond(response);
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
    "/v1/sessions/:sessionId/turns/:turnId/abort",
    async (request, reply) => {
      const controller = getSession(request.params.sessionId);
      if (!controller) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const result = await controller.abortTurn(request.params.turnId);
      if (result === "not_found") {
        return reply.code(404).send({ error: "turn_not_found" });
      }
      if (result === "failed") {
        return reply.code(500).send({ error: "turn_abort_failed" });
      }
      return reply
        .code(202)
        .send({ id: request.params.turnId, status: "aborting" });
    },
  );

  server.addHook("preClose", async () => {
    closing = true;
    for (const controller of [
      ...sessions.values(),
      ...disposingSessions.values(),
    ]) {
      controller.closeEventStreams();
    }
  });

  server.addHook("onClose", async () => {
    await Promise.allSettled([...workspaceActivations.values()]);
    const controllers = new Set([
      ...sessions.values(),
      ...disposingSessions.values(),
    ]);
    sessions.clear();
    disposingSessions.clear();
    terminalTurnListeners.clear();
    const results = await Promise.allSettled(
      [...controllers].map((controller) => controller.dispose()),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        server.log.error({ err: result.reason }, "Agent session disposal failed");
      }
    }
  });

  return { server, sessionPort };
}

export function createHttpAdapterServer(
  options: CreateHttpAdapterServerOptions,
): FastifyInstance {
  return createHttpAdapter(options).server;
}
