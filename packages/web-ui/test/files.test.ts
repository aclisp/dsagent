import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
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

async function setupServer(): Promise<{ server: FastifyInstance; workspace: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dscode-webui-files-"));
  await mkdir(path.join(workspace, "uploads"), { recursive: true });
  const server = Fastify();
  await server.register(multipart);
  registerFileRoutes(server, { ws: workspace }, { maxUploadBytes: 1024 * 1024 });
  serverState.push({ server, workspace });
  return { server, workspace };
}

async function upload(server: FastifyInstance, files: { name: string; content: string }[]) {
  return server.inject({
    method: "POST",
    url: "/v1/workspaces/ws/files",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
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
      url: "/v1/workspaces/ws/files?path=uploads/notes.txt",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("hi");
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-type"]).toContain("text/plain");
  });

  it("serves scriptable types as attachments", async () => {
    const { server, workspace } = await setupServer();
    await writeFile(path.join(workspace, "uploads", "page.html"), "<h1>x</h1>");

    const response = await server.inject({
      method: "GET",
      url: "/v1/workspaces/ws/files?path=uploads/page.html",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain("attachment");
  });

  it("rejects path traversal outside the workspace", async () => {
    const { server, workspace } = await setupServer();
    const secret = path.join(path.dirname(workspace), "outside-secret.txt");
    await writeFile(secret, "secret");

    const response = await server.inject({
      method: "GET",
      url: "/v1/workspaces/ws/files?path=uploads/../../outside-secret.txt",
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects absolute paths", async () => {
    const { server } = await setupServer();
    const response = await server.inject({
      method: "GET",
      url: "/v1/workspaces/ws/files?path=/etc/hosts",
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s for an unknown workspace, a missing file, and a directory", async () => {
    const { server, workspace } = await setupServer();
    await writeFile(path.join(workspace, "uploads", "a.txt"), "a");

    const unknown = await server.inject({
      method: "GET",
      url: "/v1/workspaces/nope/files?path=a.txt",
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("workspace_not_found");

    const missing = await server.inject({
      method: "GET",
      url: "/v1/workspaces/ws/files?path=uploads/missing.txt",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("file_not_found");

    const directory = await server.inject({
      method: "GET",
      url: "/v1/workspaces/ws/files?path=uploads",
    });
    expect(directory.statusCode).toBe(404);
  });
});