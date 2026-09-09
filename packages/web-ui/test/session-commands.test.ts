import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Exercise the browser functions with a delayed DELETE and fake HTTP responses.
// No DOM library is needed: the only rendered effects here are history/clear.
function harness(page: "chat" | "app", command: string) {
  const source = readFileSync(new URL(`../static/${page}.js`, import.meta.url), "utf8");
  function browserFunction(name: string) {
    const start = source.indexOf(`async function ${name}(`);
    if (start < 0) throw new Error(`Missing browser function: ${name}`);
    return source.slice(start, source.indexOf("\n}", start) + 2);
  }
  const response = (ok: boolean, body: unknown = null) => ({ ok, status: ok ? 200 : 500, body });
  let finishDelete!: (value: ReturnType<typeof response>) => void;
  const deletion = new Promise<ReturnType<typeof response>>((resolve) => { finishDelete = resolve; });
  const api = vi.fn(async (_path: string, options?: { method?: string }) => {
    if (options?.method === "DELETE") return deletion;
    if (_path.includes("?workspaceId=")) {
      return response(true, { sessions: [{ workspaceId: "ws", active: false, session: { id: "old" } }] });
    }
    return response(true, { status: "idle" });
  });
  const jsonPost = vi.fn(async (_path: string, body: { resumeSessionId?: string }) =>
    response(true, { id: body.resumeSessionId ?? "new", status: "idle" }));
  const renderHistory = vi.fn(async () => true);
  const clear = vi.fn();
  const openStream = vi.fn();
  const notice = vi.fn();
  const context = createContext({
    api, jsonPost, renderHistory, openStream,
    term: { clear }, endStream() {},
    document: { visibilityState: "visible" },
    messageInput: { value: command },
    resizeInput() {}, blankLine() {},
    out: notice, appendSystemNotice: notice, showReconnectNotice: notice,
    ask: vi.fn().mockResolvedValueOnce(command).mockImplementation(() => new Promise(() => {})),
    queueMicrotask,
  });
  runInContext(`
    const RECONNECT_GAP_MS = 10000;
    const USER_PROMPT = "❯ ";
    let sessionId = "old", workspaceId = "ws", clientId = "client";
    let sessionChange = null, currentTurnId = null, resolveTurn = null;
    let stream = { close() {} }, reconnecting = false, reconnectDue = false, lastReconnectAt = 0;
    let pendingUploads = ["uploads/example.txt"];
    const state = {
      sessionId, workspaceId, stream, connected: true, pendingUploads,
      running: false, submitting: false, uploading: false,
      reconnecting, reconnectDue, lastReconnectAt, historySyncDue: false,
      sessionChange: null,
    };
    function setConnection(connected) { state.connected = connected; }
    function reconcileSessionStatus(session) { state.sessionId = session.id; }
    ${page === "chat"
      ? ["activateSession", "attachSession", "reconnect", "submitMessage"].map(browserFunction).join("\n")
      : ["reattach", "reconnect", "waitTurn", "chatLoop"].map(browserFunction).join("\n")}
    globalThis.submit = () => ${page === "chat" ? "submitMessage()" : "chatLoop()"};
    globalThis.retry = () => {
      state.lastReconnectAt = 0;
      lastReconnectAt = 0;
      return reconnect();
    };
    globalThis.inspect = () => ${page === "chat" ? "state" : "({ sessionId, sessionChange, pendingUploads })"};
  `, context);
  return {
    api, jsonPost, renderHistory, clear, openStream, notice,
    finishDelete: (ok = true) => finishDelete(response(ok)),
    submit: () => { void runInContext("submit()", context); },
    retry: () => runInContext("retry()", context) as Promise<void>,
    inspect: () => runInContext("inspect()", context) as {
      sessionId: string;
      sessionChange: unknown;
      pendingUploads: string[];
    },
  };
}

describe.each(["chat", "app"] as const)("%s internal session commands", (page) => {
  it.each(["/reload", "/clear"])("waits for DELETE before reconnecting for %s", async (command) => {
    const browser = harness(page, command);
    browser.submit();
    await vi.waitFor(() => expect(browser.api).toHaveBeenCalledWith("/v1/sessions/old", { method: "DELETE" }));
    expect(browser.jsonPost).not.toHaveBeenCalled();
    expect(browser.api.mock.calls.some(([path]) => path.includes("?workspaceId="))).toBe(false);

    browser.finishDelete();
    await vi.waitFor(() => expect(browser.openStream).toHaveBeenCalledOnce());
    expect(browser.jsonPost).toHaveBeenCalledExactlyOnceWith("/v1/sessions", command === "/reload"
      ? { workspaceId: "ws", resumeSessionId: "old" }
      : { workspaceId: "ws" });
    expect(browser.inspect().sessionId).toBe(command === "/reload" ? "old" : "new");
    expect(browser.inspect().sessionChange).toBeNull();
    expect(browser.inspect().pendingUploads).toEqual(["uploads/example.txt"]);
    expect(browser.renderHistory).toHaveBeenCalledTimes(page === "chat" && command === "/clear" ? 1 : 0);
    expect(browser.clear).toHaveBeenCalledTimes(page === "app" && command === "/clear" ? 1 : 0);
  });

  it("retains clear intent across a failed create without repeating DELETE", async () => {
    const browser = harness(page, "/clear");
    browser.jsonPost.mockResolvedValueOnce({ ok: false, status: 500, body: null });
    browser.submit();
    browser.finishDelete();
    await vi.waitFor(() => expect(browser.jsonPost).toHaveBeenCalledOnce());
    expect(browser.inspect().sessionChange).not.toBeNull();
    expect(browser.clear).not.toHaveBeenCalled();
    expect(browser.renderHistory).not.toHaveBeenCalled();

    await browser.retry();
    expect(browser.jsonPost.mock.calls).toEqual([
      ["/v1/sessions", { workspaceId: "ws" }],
      ["/v1/sessions", { workspaceId: "ws" }],
    ]);
    expect(browser.api.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(1);
    expect(browser.inspect().sessionChange).toBeNull();
    expect(browser.openStream).toHaveBeenCalledOnce();
  });

  it("does not create or clear the display when DELETE fails", async () => {
    const browser = harness(page, "/clear");
    browser.submit();
    browser.finishDelete(false);
    await vi.waitFor(() => expect(browser.notice).toHaveBeenCalled());
    expect(browser.inspect().sessionChange).toBeNull();
    expect(browser.jsonPost).not.toHaveBeenCalled();
    expect(browser.clear).not.toHaveBeenCalled();
    expect(browser.renderHistory).not.toHaveBeenCalled();
  });
});
