import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpAdapter } from "../../http-adapter/src/http-server.js";
import { registerFileRoutes } from "../src/files.js";

const BOUNDARY = "----dscode-test-boundary";
const CRLF = "\r\n";

function multipartBody(files: { name: string; content: string }[]): string {
  const parts = files
    .map(
      (file) =>
        `--${BOUNDARY}${CRLF}` +
        `Content-Disposition: form-data; name="files"; filename="${file.name}"${CRLF}` +
        "Content-Type: application/octet-stream" + CRLF + CRLF +
        `${file.content}${CRLF}`,
    )
    .join("");
  return `${parts}--${BOUNDARY}--${CRLF}`;
}

const serverState: { server: FastifyInstance; workspace: string }[] = [];

afterEach(async () => {
  await Promise.all(serverState.splice(0).map(({ server }) => server.close()));
  await Promise.all(
    serverState.splice(0).map(({ workspace }) =>
      rm(workspace, { recursive: true, force: true }),
    ),
  );
});

async function setupServer(options?: {
  corsOrigins?: readonly string[];
}): Promise<{ server: FastifyInstance; workspace: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dscode-webui-files-"));
  await mkdir(path.join(workspace, "uploads"), { recursive: true });
  const server = options?.corsOrigins
    ? createHttpAdapter({
        workspaces: { ws: workspace },
        corsOrigins: options.corsOrigins,
      }).server
    : Fastify();
  await server.register(multipart);
  registerFileRoutes(server, { ws: workspace }, { maxUploadBytes: 1024 * 1024 });
  serverState.push({ server, workspace });
  return { server, workspace };
}

async function upload(
  server: FastifyInstance,
  files: { name: string; content: string }[],
  origin?: string,
) {
  return server.inject({
    method: "POST",
    url: "/v1/workspaces/ws/files",
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      ...(origin !== undefined ? { origin } : {}),
    },
    payload: multipartBody(files),
  });
}

describe("workspace file routes", () => {
  it("uploads files into the uploads/ subdirectory and reports them", async () => {
    const { server, workspace } = await setupServer();
    const response = await upload(server, [{ name: "hello.txt", content: "hello world" }]);

    expect(response.statusCode).toBe(201);
    expect(response.json().files).toEqual([
      { name: "hello.txt", path: "uploads/hello.txt", size: 11 },
    ]);
    expect(await readFile(path.join(workspace, "uploads", "hello.txt"), "utf8")).toBe(
      "hello world",
    );
  });

  it("allows configured origins to upload but not read share routes through CORS", async () => {
    const origin = "https://app.example.com";
    const { server } = await setupServer({ corsOrigins: [origin] });

    const preflight = await server.inject({
      method: "OPTIONS",
      url: "/v1/workspaces/ws/files",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(origin);

    const uploaded = await upload(
      server,
      [{ name: "photo.png", content: "image" }],
      origin,
    );
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.headers["access-control-allow-origin"]).toBe(origin);

    const shared = await server.inject({
      method: "GET",
      url: "/share/ws/uploads/photo.png",
      headers: { origin },
    });
    expect(shared.statusCode).toBe(200);
    expect(shared.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("stores path-like filenames safely — busboy strips directory parts", async () => {
    const { server, workspace } = await setupServer();
    const response = await upload(server, [{ name: "../evil.txt", content: "x" }]);

    expect(response.statusCode).toBe(201);
    expect(response.json().files[0].path).toBe("uploads/evil.txt");
    expect(await readFile(path.join(workspace, "uploads", "evil.txt"), "utf8")).toBe("x");
  });

  it("rejects invalid filenames", async () => {
    const { server, workspace } = await setupServer();
    const response = await upload(server, [{ name: "..", content: "x" }]);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_upload");
    await expect(readFile(path.join(workspace, "uploads", "x"))).rejects.toThrow();
  });

  it("rejects a request that is not multipart", async () => {
    const { server } = await setupServer();
    const response = await server.inject({
      method: "POST",
      url: "/v1/workspaces/ws/files",
      payload: "{}",
    });
    expect(response.statusCode).toBe(415);
  });

  it("serves a file inline with nosniff", async () => {
    const { server, workspace } = await setupServer();
    await writeFile(path.join(workspace, "uploads", "notes.txt"), "hi");

    const response = await server.inject({
      method: "GET",
      url: "/share/ws/uploads/notes.txt",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("hi");
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-type"]).toContain("text/plain");
  });

  it("serves YAML files inline as plain text", async () => {
    const { server, workspace } = await setupServer();
    await writeFile(path.join(workspace, "uploads", "schedules.yaml"), "version: 1\n");

    const response = await server.inject({
      method: "GET",
      url: "/share/ws/uploads/schedules.yaml",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("version: 1\n");
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves HTML pages inline with the HTML content type", async () => {
    const { server, workspace } = await setupServer();
    for (const name of ["page.html", "page.htm"]) {
      await writeFile(path.join(workspace, "uploads", name), "<h1>x</h1>");

      const response = await server.inject({
        method: "GET",
        url: `/share/ws/uploads/${name}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("<h1>x</h1>");
      expect(response.headers["content-disposition"]).toContain("inline");
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("serves H5 assets with browser MIME types", async () => {
    const { server, workspace } = await setupServer();
    await writeFile(path.join(workspace, "uploads", "app.js"), "console.log('ok');");
    await writeFile(path.join(workspace, "uploads", "style.css"), "body { color: red; }");

    const script = await server.inject({
      method: "GET",
      url: "/share/ws/uploads/app.js",
    });
    const style = await server.inject({
      method: "GET",
      url: "/share/ws/uploads/style.css",
    });

    expect(script.headers["content-type"]).toContain("text/javascript");
    expect(script.headers["content-disposition"]).toContain("inline");
    expect(style.headers["content-type"]).toContain("text/css");
    expect(style.headers["content-disposition"]).toContain("inline");
  });

  it("serves supported Office documents inline with their Office MIME types", async () => {
    const { server, workspace } = await setupServer();
    const cases = [
      ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["table.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ] as const;

    for (const [name, contentType] of cases) {
      await writeFile(path.join(workspace, "uploads", name), "office-content");
      const response = await server.inject({
        method: "GET",
        url: `/share/ws/uploads/${name}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-disposition"]).toContain("inline");
      expect(response.headers["content-type"]).toContain(contentType);
    }
  });

  it("rejects path traversal outside the workspace", async () => {
    const { server, workspace } = await setupServer();
    const secret = path.join(path.dirname(workspace), "outside-secret.txt");
    await writeFile(secret, "secret");

    const response = await server.inject({
      method: "GET",
      url: "/share/ws/uploads/../../outside-secret.txt",
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects absolute paths", async () => {
    const { server } = await setupServer();
    const response = await server.inject({
      method: "GET",
      url: "/share/ws/%2Fetc%2Fhosts",
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s for an unknown workspace, a missing file, and a directory", async () => {
    const { server, workspace } = await setupServer();
    await writeFile(path.join(workspace, "uploads", "a.txt"), "a");

    const unknown = await server.inject({
      method: "GET",
      url: "/share/nope/a.txt",
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("workspace_not_found");

    const missing = await server.inject({
      method: "GET",
      url: "/share/ws/uploads/missing.txt",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("file_not_found");

    const directory = await server.inject({
      method: "GET",
      url: "/share/ws/uploads",
    });
    expect(directory.statusCode).toBe(404);
  });
});
