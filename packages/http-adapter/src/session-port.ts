export interface SessionPortActivation {
  sessionId: string;
}

/**
 * Internal provenance carried by non-browser Turns. This type is intentionally
 * kept on the in-process Session Port and is never part of the HTTP/SSE API.
 */
export interface SessionPortTurnSourceContext {
  readonly type: "im";
  readonly conversationAlias: string;
}

export interface SessionPortTurnContext {
  readonly source?: SessionPortTurnSourceContext;
}

export type SessionPortTurnSubmission =
  | { status: "accepted"; turnId: string }
  | { status: "busy" };

export type SessionPortTurnEvent =
  | {
      status: "completed";
      turnId: string;
      output: string | null;
      context?: SessionPortTurnContext;
    }
  | { status: "failed"; turnId: string; context?: SessionPortTurnContext }
  | { status: "aborted"; turnId: string; context?: SessionPortTurnContext };

export type SessionPortTurnListener = (
  event: SessionPortTurnEvent,
) => void | Promise<void>;

export interface SessionPort {
  activate(workspaceId: string): Promise<SessionPortActivation>;
  submitTurn(
    workspaceId: string,
    message: string,
    context?: SessionPortTurnContext,
  ): Promise<SessionPortTurnSubmission>;
  subscribe(listener: SessionPortTurnListener): () => void;
}
