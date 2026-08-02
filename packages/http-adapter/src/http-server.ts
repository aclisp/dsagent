import Fastify, { type FastifyInstance } from "fastify";

export interface HttpAdapterServerHost {
  readonly session: {
    getLastAssistantText(): string | undefined;
  };
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}

interface TurnBody {
  message: string;
}

const turnBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1 },
  },
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
  let turnActive = false;

  server.get("/health", async () => ({ status: "ok" }));

  server.post<{ Body: TurnBody }>(
    "/v1/turns",
    { schema: { body: turnBodySchema } },
    async (request, reply) => {
      if (request.body.message.trim().length === 0) {
        return reply.code(400).send({ error: "invalid_message" });
      }
      if (turnActive) {
        return reply.code(409).send({ error: "turn_in_progress" });
      }

      turnActive = true;
      try {
        await host.prompt(request.body.message);
        await host.waitForIdle();
        return { output: host.session.getLastAssistantText() ?? null };
      } catch (error) {
        request.log.error({ err: error }, "Agent turn failed");
        return reply.code(500).send({ error: "turn_failed" });
      } finally {
        turnActive = false;
      }
    },
  );

  server.addHook("onClose", async () => {
    try {
      await host.abort();
    } finally {
      await host.dispose();
    }
  });

  return server;
}
