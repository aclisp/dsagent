export interface SessionPortActivation {
  sessionId: string;
}

export type SessionPortTurnSubmission =
  | { status: "accepted"; turnId: string }
  | { status: "busy" };

export type SessionPortTurnEvent =
  | { status: "completed"; turnId: string; output: string | null }
  | { status: "failed"; turnId: string }
  | { status: "aborted"; turnId: string };

export type SessionPortTurnListener = (
  event: SessionPortTurnEvent,
) => void | Promise<void>;

export interface SessionPort {
  activate(workspaceId: string): Promise<SessionPortActivation>;
  submitTurn(
    workspaceId: string,
    message: string,
  ): Promise<SessionPortTurnSubmission>;
  subscribe(listener: SessionPortTurnListener): () => void;
}
