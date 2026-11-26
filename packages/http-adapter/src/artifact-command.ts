export interface ArtifactPublicationSummary {
  entry: string;
  publishedAt: string;
  sharePath: string;
}

export type ArtifactCommandDetails =
  | { kind: "preview"; directory: string; entry: string; files: readonly string[] }
  | { kind: "published"; publication: ArtifactPublicationSummary }
  | { kind: "list"; publications: readonly ArtifactPublicationSummary[] };

export interface ArtifactCommandResult {
  content: Array<{ type: "text"; text: string }>;
  details: { artifact: ArtifactCommandDetails | undefined };
}

export interface ArtifactCommandContext {
  workspacePath: string;
  sessionId: string;
}

export type ArtifactCommand = (
  args: readonly string[],
  context: ArtifactCommandContext,
  signal?: AbortSignal,
) => Promise<ArtifactCommandResult>;

export function getArtifactCommandDetails(details: unknown): ArtifactCommandDetails | undefined {
  if (typeof details !== "object" || details === null || !("artifact" in details)) return;
  const { artifact } = details;
  if (typeof artifact !== "object" || artifact === null || !("kind" in artifact)) return;
  if (artifact.kind === "preview" || artifact.kind === "published" || artifact.kind === "list") {
    return artifact as ArtifactCommandDetails;
  }
}
