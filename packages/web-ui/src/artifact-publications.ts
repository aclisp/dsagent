import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  ArtifactCommandContext,
  ArtifactCommandDetails,
  ArtifactCommandResult,
  ArtifactPublicationSummary,
} from "@aclisp/dsagent-http-adapter";
import type { FastifyInstance, FastifyReply } from "fastify";
import { contentTypeFor } from "./files.ts";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{12}$/;

interface Publication {
  owner: string;
  entry: string;
  publishedAt: string;
}

interface Draft {
  location: string;
  owner: string;
  entry: string;
}

export class ArtifactPublications {
  private readonly drafts = new Map<string, Draft>();
  private readonly root: string;
  private readonly owners: Promise<Set<string>>;
  private closed = false;

  constructor(
    root: string,
    workspaces: Readonly<Record<string, string>>,
  ) {
    this.root = root;
    this.owners = Promise.all(Object.values(workspaces).map(async cwd => {
      const canonical = await realpath(cwd).catch(() => path.resolve(cwd));
      return workspaceOwner(canonical);
    })).then(owners => new Set(owners));
  }

  async command(
    args: readonly string[],
    context: ArtifactCommandContext,
    signal?: AbortSignal,
  ): Promise<ArtifactCommandResult> {
    if (this.closed) throw new Error("Artifact publishing is unavailable while Web is shutting down");
    signal?.throwIfAborted();
    const workspace = await realpath(context.workspacePath);
    const owner = workspaceOwner(workspace);
    if (!(await this.owners).has(owner)) throw new Error("Artifact workspace is unavailable");
    const draftKey = JSON.stringify([owner, context.sessionId]);
    const [action, first, second] = args;

    if (action === "preview" && args.length === 3 && first && second) {
      return this.prepare(draftKey, owner, workspace, first, second, signal);
    }
    if (action === "publish" && args.length === 1) return this.publish(draftKey, signal);
    if (action === "list" && args.length === 1) return this.list(owner);
    if (action === "revoke" && args.length === 2 && first && TOKEN_PATTERN.test(first)) {
      return this.revoke(owner, first, signal);
    }
    throw new Error("Usage: dscode-artifact preview <directory> <entry> | publish | list | revoke <shareToken>");
  }

  registerRoutes(server: FastifyInstance): void {
    server.addHook("onClose", async () => {
      this.closed = true;
      const drafts = [...this.drafts.values()];
      this.drafts.clear();
      await Promise.all(drafts.map(draft => discardDraft(draft.location)));
    });
    const register = (url: string) => server.route<{ Params: { token: string; "*"?: string } }>({
      method: ["GET", "HEAD"],
      url,
      handler: async (request, reply) => {
        reply.header("Cache-Control", "no-store")
          .header("Referrer-Policy", "no-referrer")
          .header("X-Content-Type-Options", "nosniff");
        const { token, "*": asset } = request.params;
        try {
          const publication = await this.find(token);
          if (!publication || !(await this.owners).has(publication.owner)) return artifactNotFound(reply);
          if (!asset) return reply.redirect(sharePath(token) + encodePath(publication.entry));
          if (!isVisiblePath(asset)) return artifactNotFound(reply);

          const file = path.join(this.root, token, "files", asset);
          const info = await lstat(file);
          if (!info.isFile()) return artifactNotFound(reply);
          reply.type(contentTypeFor(asset)).header("Content-Length", info.size);
          return request.method === "HEAD" ? reply.send() : reply.send(createReadStream(file));
        } catch (error) {
          if (isMissing(error)) return artifactNotFound(reply);
          request.log.error({ err: error }, "Unable to serve an artifact snapshot");
          return reply.code(500).send({ error: "artifact_unavailable" });
        }
      },
    });
    register("/s/:token");
    register("/s/:token/*");
  }

  private async prepare(
    key: string,
    owner: string,
    workspace: string,
    requestedDirectory: string,
    requestedEntry: string,
    signal?: AbortSignal,
  ): Promise<ArtifactCommandResult> {
    const previous = this.drafts.get(key);
    this.drafts.delete(key);
    if (previous) await discardDraft(previous.location);
    const directory = requestedDirectory === "." || requestedDirectory === "./"
      ? "."
      : requestedDirectory.replace(/^\.\//, "").replace(/\/+$/, "");
    const entry = requestedEntry.replace(/^\.\//, "");
    if (directory !== "." && !isVisiblePath(directory)) throw new Error("Choose a visible workspace-relative directory");
    if (!isVisiblePath(entry) || !/\.html?$/i.test(entry)) throw new Error("Choose a visible HTML entry relative to that directory");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.root)).isDirectory()) throw new Error("Invalid artifact storage directory");
    const location = await mkdtemp(path.join(this.root, ".preview-"));
    try {
      const files: string[] = [];
      const destination = path.join(location, "files");
      await mkdir(destination, { mode: 0o700 });
      await copyDirectory(path.resolve(workspace, directory), destination, "", files, signal);
      if (!files.includes(entry)) throw new Error("The HTML entry was not found in the snapshot");
      signal?.throwIfAborted();
      if (this.closed) throw new Error("Web is shutting down");
      this.drafts.set(key, { location, owner, entry });
      return result(
        [
          `Prepared ${files.length} files from ${JSON.stringify(directory)} with entry ${JSON.stringify(entry)}:`,
          ...files.map(file => JSON.stringify(file)),
        ].join("\n"),
        { kind: "preview", directory, entry, files },
      );
    } catch (error) {
      await discardDraft(location);
      if (isMissing(error)) throw new Error("A selected artifact path was missing or changed during preparation");
      throw error;
    }
  }

  private async publish(
    key: string,
    signal?: AbortSignal,
  ): Promise<ArtifactCommandResult> {
    const draft = this.drafts.get(key);
    if (!draft) throw new Error("Prepare an artifact snapshot before publishing");
    const publication: Publication = { owner: draft.owner, entry: draft.entry, publishedAt: new Date().toISOString() };
    await writeFile(path.join(draft.location, "publication.json"), JSON.stringify(publication), { mode: 0o600 });
    while (true) {
      signal?.throwIfAborted();
      if (this.closed) throw new Error("Web is shutting down");
      const token = randomBytes(9).toString("base64url");
      try {
        await rename(draft.location, path.join(this.root, token));
      } catch (error) {
        if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOTEMPTY") continue;
        throw error;
      }
      this.drafts.delete(key);
      const published = summarize(token, publication);
      return result(`Published: ${published.sharePath}`, { kind: "published", publication: published });
    }
  }

  private async list(owner: string): Promise<ArtifactCommandResult> {
    let directories: string[];
    try {
      directories = await readdir(this.root);
    } catch (error) {
      if (!isMissing(error)) throw error;
      directories = [];
    }
    const publications: ArtifactPublicationSummary[] = [];
    for (const token of directories) {
      const publication = await this.find(token);
      if (publication?.owner === owner) publications.push(summarize(token, publication));
    }
    publications.sort((first, second) => second.publishedAt.localeCompare(first.publishedAt));
    return result(
      publications.length
        ? publications.map(({ entry, publishedAt, sharePath }) => `${sharePath}  ${publishedAt}  ${JSON.stringify(entry)}`).join("\n")
        : "No active share links.",
      { kind: "list", publications },
    );
  }

  private async revoke(owner: string, token: string, signal?: AbortSignal): Promise<ArtifactCommandResult> {
    const publication = await this.find(token);
    if (publication?.owner !== owner) throw new Error("Active share link not found in this workspace");
    signal?.throwIfAborted();
    // Retain the publication record to reserve the token after revocation.
    const location = path.join(this.root, token);
    try {
      await writeFile(path.join(location, "revoked"), "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    return result(`Revoked: ${sharePath(token)}`);
  }

  private async find(token: string): Promise<Publication | undefined> {
    if (!TOKEN_PATTERN.test(token)) return;
    const location = path.join(this.root, token);
    try {
      await lstat(path.join(location, "revoked"));
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const manifest = await readFile(path.join(location, "publication.json"), "utf8").catch((error: unknown) => {
      if (!isMissing(error)) throw error;
      return undefined;
    });
    if (!manifest) return;
    const publication = JSON.parse(manifest) as Publication;
    if (typeof publication.owner === "string" && typeof publication.publishedAt === "string" && isVisiblePath(publication.entry)) {
      return publication;
    }
  }
}

async function copyDirectory(
  source: string,
  destination: string,
  prefix: string,
  files: string[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (await realpath(source) !== source || !(await lstat(source)).isDirectory()) {
    throw new Error("The selected directory must be a real directory without symlinks");
  }
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((first, second) => first.name.localeCompare(second.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix + entry.name;
    if (!isVisiblePath(relative)) throw new Error(`Unsupported artifact path: ${JSON.stringify(relative)}`);
    signal?.throwIfAborted();
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { mode: 0o700 });
      await copyDirectory(from, to, relative + "/", files, signal);
    } else if (entry.isFile()) {
      await copyRegularFile(from, to, relative, signal);
      files.push(relative);
    } else {
      throw new Error(`Artifact path is not a regular file or directory: ${JSON.stringify(relative)}`);
    }
  }
}

async function copyRegularFile(source: string, destination: string, relative: string, signal?: AbortSignal): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await input.stat();
    const named = await lstat(source);
    if (!opened.isFile() || !named.isFile() || opened.ino !== named.ino || opened.dev !== named.dev || await realpath(source) !== source) {
      throw new Error(`Artifact source changed while copying: ${JSON.stringify(relative)}`);
    }
    await pipeline(
      input.createReadStream({ autoClose: false }),
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      { signal },
    );
  } finally {
    await input.close();
  }
}

function isVisiblePath(value: unknown): value is string {
  return typeof value === "string" && !/[\\:\u0000-\u001f\u007f]/.test(value) &&
    value.split("/").every(segment => segment.length > 0 && !segment.startsWith("."));
}

function encodePath(relative: string): string {
  return relative.split("/").map(segment => encodeURIComponent(segment)).join("/");
}

function workspaceOwner(canonicalWorkspace: string): string {
  return createHash("sha256").update(canonicalWorkspace).digest("hex");
}

function sharePath(token: string): string {
  return `/s/${token}/`;
}

function summarize(token: string, publication: Publication): ArtifactPublicationSummary {
  return { entry: publication.entry, publishedAt: publication.publishedAt, sharePath: sharePath(token) };
}

function result(text: string, artifact?: ArtifactCommandDetails): ArtifactCommandResult {
  return { content: [{ type: "text", text }], details: { artifact } };
}

function artifactNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: "artifact_not_found" });
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
}

async function discardDraft(location: string): Promise<void> {
  await rm(location, { force: true, recursive: true }).catch(() => undefined);
}
