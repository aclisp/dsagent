import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("../static/chat.js", import.meta.url), "utf8");

function section(first: string, after: string) {
  const startOf = (name: string) => source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  return source.slice(startOf(first), startOf(after));
}

function harness() {
  const recordTool = vi.fn();
  const appendSystemNotice = vi.fn();
  const turn = {};
  const ignore = () => {};
  const handlers = runInNewContext(`
    ${section("toolResultText", "updateWorkProcess")}
    ${section("onTurn", "modalButton")}
    ${section("renderHistoryMessage", "renderHistory")}
    ({ handleToolEvent, renderHistoryMessage, onTurn })
  `, {
    state: { currentTurnId: "turn", liveTurn: turn },
    ensureLiveTurn: () => turn,
    recordTool, appendSystemNotice,
    closeModal: ignore, finishWorkProcess: ignore, removeTyping: ignore,
    moveTypingToBottom: ignore, setRunning: ignore, appendArtifactResult: ignore,
  });
  return { handlers, recordTool, appendSystemNotice, turn };
}

it.each([
  ["exec_command", false, "Denied by user", "completed"],
  ["exec_command", false, "dscode: denied by user", "completed"],
  ["exec_command", true, "dscode: denied by user", "failed"],
  ["exec_command", true, "Denied request by user", "failed"],
  ["exec_command", true, "User denied the premise", "failed"],
  ["exec_command", true, "Command output:\nDestructive command denied by user", "failed"],
  ["apply_patch", true, "Denied file.txt by user\nPatch failed", "failed"],
  ["read", true, "Denied by user", "denied"],
  ["exec_command", true, "Destructive command denied by user", "denied"],
  ["apply_patch", true, "Denied docs/file name.md by user", "denied"],
  ["exec_command", true, "User denied network access for: curl example.com", "denied"],
  ["exec_command", true, "User denied unrestricted host filesystem and network access for: git status", "denied"],
])("classifies %s (isError=%s): %s → %s in live and historical results", (name, isError, text, outcome) => {
  const { handlers, recordTool, turn } = harness();
  const content = [{ type: "text", text }];
  handlers.handleToolEvent({ turnId: "turn", phase: "completed", toolCallId: "live", name, isError, result: { content } });
  handlers.renderHistoryMessage({
    role: "toolResult", toolCallId: "history", toolName: name, isError, content, timestamp: 1,
  }, turn);
  expect(recordTool.mock.calls.map((call) => call[6])).toEqual([outcome, outcome]);
});

it("uses nested tool errors, not successful nested results, to mark historical denials", () => {
  const { handlers, recordTool, turn } = harness();
  handlers.renderHistoryMessage({
    role: "toolResult", toolCallId: "parent", toolName: "codemode", isError: false, content: [], timestamp: 1,
    nestedCalls: { calls: [
      { id: "ok", name: "exec_command", status: "ok", error: "Denied by user" },
      { id: "denied", name: "exec_command", status: "error", error: "Destructive command denied by user" },
    ] },
  }, turn);
  expect(recordTool.mock.calls.map((call) => call[6])).toEqual(["completed", "completed", "denied"]);
});

it("does not treat a failed turn's raw error string as an approval result", () => {
  const { handlers, appendSystemNotice } = harness();
  handlers.onTurn({ status: "failed", turnId: "turn", error: "Denied by user" });
  expect(appendSystemNotice).toHaveBeenCalledWith("这次没有处理成功，请重试。", "error");
});
