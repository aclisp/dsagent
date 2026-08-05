import { Termino } from "./termino.js";

const term = Termino(document.getElementById("terminal"));
const stopButton = document.getElementById("stop");
term.disable_input();

// Identifies this page to the adapter so it can skip echoing our own input.
const clientId = crypto.randomUUID();

let sessionId = null;
let workspaceId = null;
let stream = null;
let currentTurnId = null;
let resolveTurn = null;
let streamBlock = null;
let streamText = "";
let reconnectNoted = false;
let dialogChain = Promise.resolve();
let dialogOpen = false;

// --- helpers -----------------------------------------------------------

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

// One-line summary of a tool call's args, mirroring the agent's own TUI summary.
// Falls back to the bare tool name when nothing is extractable.
function toolSummary(name, args = {}) {
  const str = (value) => (typeof value === "string" ? value : "");
  const qualified = (detail) => (detail ? `${name}: ${detail}` : name);
  if (name === "exec_command") return qualified(truncate(oneLine(str(args.cmd)), 80));
  if (name === "read_file") {
    const range = args.line_start || args.line_end
      ? `:${str(args.line_start) || "1"}-${str(args.line_end)}`
      : "";
    return qualified(`${oneLine(str(args.path))}${range}`);
  }
  if (name === "list_files") return qualified(oneLine(str(args.pattern)));
  if (name === "search_files") {
    const path = str(args.path);
    return qualified(`${truncate(oneLine(str(args.query)), 80)}${path ? ` in ${path}` : ""}`);
  }
  if (name === "write_stdin") {
    if (str(args.chars) !== "") return qualified(truncate(oneLine(str(args.chars)), 80));
    if (args.terminate) return "write_stdin: terminate";
    return name;
  }
  if (name === "apply_patch") {
    const files = new Set();
    for (const line of String(args.input ?? "").split("\n")) {
      const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim());
      if (match) files.add(match[1]);
    }
    if (files.size > 0) {
      return `apply_patch: ${files.size} file${files.size > 1 ? "s" : ""}`;
    }
    return name;
  }
  if (name === "update_plan" && Array.isArray(args.steps)) {
    return `update_plan: ${args.steps.length} steps`;
  }
  return name;
}

// Append via a template instead of Termino's innerHTML +=, which re-parses
// the console and detaches the streaming block mid-turn. Content added after
// the streaming block invalidates it, so the next delta starts a new block
// at the end instead of writing into the old position.
function outHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  document.querySelector(".termino-console").appendChild(template.content);
  streamBlock = null;
  streamText = "";
  term.scroll_to_bottom();
}

function out(text) {
  outHtml(`<pre>${escapeHtml(text)}</pre>`);
}

async function ask(question) {
  term.enable_input();
  document.querySelector(".termino-input").focus();
  try {
    return await term.input(escapeHtml(question));
  } finally {
    term.disable_input();
  }
}

async function askDialog(question) {
  dialogOpen = true;
  try {
    return await ask(question);
  } finally {
    dialogOpen = false;
  }
}

async function api(path, options = {}) {
  try {
    const response = await fetch(path, options);
    const text = await response.text();
    let body = null;
    if (text.length > 0) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: { error: String(error) } };
  }
}

const jsonPost = (path, body) => api(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function showIndicator(text) {
  hideIndicator();
  outHtml(`<pre class="indicator">${escapeHtml(text)}</pre>`);
  const consoleElement = document.querySelector(".termino-console");
  const indicator = consoleElement.lastElementChild;
  if (indicator) indicator.id = "indicator";
  term.scroll_to_bottom();
}

function hideIndicator() {
  document.getElementById("indicator")?.remove();
}

// The agent's own working status arrives every second as a ui_event; render it into a
// dedicated slot (distinct from the thinking/compaction indicator) and update in place.
function showWorking(message) {
  let line = document.getElementById("working");
  if (!line) {
    outHtml('<pre class="indicator" id="working"></pre>');
    line = document.getElementById("working");
  }
  line.textContent = message;
}

function hideWorking() {
  document.getElementById("working")?.remove();
}

function appendDelta(delta) {
  if (!streamBlock) {
    streamText = "";
    streamBlock = document.createElement("pre");
    document.querySelector(".termino-console").appendChild(streamBlock);
  }
  streamText += delta;
  streamBlock.textContent = streamText;
  term.scroll_to_bottom();
}

function endStream() {
  streamBlock = null;
  streamText = "";
}

// --- events ------------------------------------------------------------

function onTurn(event) {
  if (event.status === "running" || event.status === "aborting") {
    currentTurnId = event.turnId;
    stopButton.hidden = false;
    // Another client submitted the turn: show its input (ours is already in the
    // prompt line).
    if (
      event.status === "running"
      && event.message !== undefined
      && event.clientId !== clientId
    ) {
      blankLine();
      out(`> ${event.message}`);
      blankLine();
    }
    return;
  }
  hideIndicator();
  hideWorking();
  endStream();
  stopButton.hidden = true;
  currentTurnId = null;
  if (event.status === "failed") {
    outHtml(
      event.error
        ? `<pre class="muted">[turn failed: ${escapeHtml(event.error)}]</pre>`
        : '<pre class="muted">[turn failed]</pre>',
    );
  }
  if (event.status === "aborted") outHtml('<pre class="muted">[turn aborted]</pre>');
  if (dialogOpen) term.cancel_input();
  if (resolveTurn) {
    const resolve = resolveTurn;
    resolveTurn = null;
    resolve();
  }
}

async function handleUiRequest(request, turnId) {
  // The turn may have ended while this request waited in dialogChain or while
  // its question was on screen; skip stale dialogs instead of posting to a
  // cancelled request.
  if (turnId !== currentTurnId) return;
  let answer;
  if (request.method === "confirm") {
    out(`! ${request.title}`);
    if (request.message) out(request.message);
    const value = await askDialog("(y/n) > ");
    answer = value === undefined
      ? { cancelled: true }
      : { confirmed: /^y(es)?$/i.test(value.trim()) };
  } else if (request.method === "select") {
    out(request.title);
    request.options.forEach((option, index) => out(`  ${index + 1}. ${option}`));
    const value = await askDialog("choose # > ");
    const option = request.options[Number(value) - 1];
    answer = value === undefined || option === undefined
      ? { cancelled: true }
      : { value: option };
  } else {
    out(request.title);
    const value = await askDialog("> ");
    answer = value === undefined ? { cancelled: true } : { value };
  }
  if (turnId !== currentTurnId) return;
  const response = await api(
    `/v1/sessions/${sessionId}/ui-requests/${request.id}/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answer),
    },
  );
  if (!response.ok) out(`[dialog response rejected: ${response.body?.error ?? response.status}]`);
}

function openStream() {
  const source = new EventSource(`/v1/sessions/${sessionId}/events`);
  stream = source;
  source.addEventListener("open", () => {
    document.getElementById("reconnect-notice")?.remove();
    reconnectNoted = false;
  });
  source.addEventListener("error", () => {
    if (!reconnectNoted) {
      outHtml('<pre id="reconnect-notice" class="muted">[connection lost — reconnecting…]</pre>');
      reconnectNoted = true;
    }
  });
  source.addEventListener("turn", (e) => onTurn(JSON.parse(e.data)));
  source.addEventListener("assistant_text_delta", (e) => appendDelta(JSON.parse(e.data).delta));
  source.addEventListener("thinking_start", () => showIndicator("…thinking"));
  source.addEventListener("thinking_end", hideIndicator);
  source.addEventListener("compaction_start", () => showIndicator("…summarizing context"));
  source.addEventListener("compaction_end", hideIndicator);
  source.addEventListener("tool", (e) => {
    const event = JSON.parse(e.data);
    if (event.phase === "started") {
      outHtml(`<pre class="muted">⚙ ${escapeHtml(toolSummary(event.name, event.args))}</pre>`);
    } else if (event.phase === "completed") {
      outHtml(`<pre class="muted">${event.isError ? "✗" : "✓"} ${escapeHtml(event.name)}</pre>`);
    }
  });
  source.addEventListener("ui_request", (e) => {
    const { request, turnId } = JSON.parse(e.data);
    dialogChain = dialogChain.then(() => handleUiRequest(request, turnId));
  });
  source.addEventListener("extension_error", (e) => {
    out(`[extension error: ${JSON.parse(e.data).error.message}]`);
  });
  source.addEventListener("ui_event", (e) => {
    const event = JSON.parse(e.data).event;
    if (event.method === "notify") {
      out(`[note] ${event.message}`);
    } else if (event.method === "working_message") {
      if (event.message !== undefined) {
        // The TUI suffix ("esc to interrupt") has no web equivalent; the Stop button is.
        showWorking(event.message.replace(/\s*·\s*esc to interrupt/, ""));
      } else {
        hideWorking();
      }
    }
  });
}

// --- flow ---------------------------------------------------------------

async function renderHistory() {
  const response = await api(`/v1/sessions/${sessionId}/messages`);
  if (!response.ok) {
    out(`[could not load history: ${response.status}]`);
    return;
  }
  for (const message of response.body.messages) {
    if (message.role === "user") {
      for (const block of message.content) {
        blankLine();
        out(`> ${block.text}`);
        blankLine();
      }
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text") out(block.text);
        else outHtml(`<pre class="muted">⚙ ${escapeHtml(toolSummary(block.name, block.arguments))}</pre>`);
      }
    } else if (message.role === "toolResult") {
      outHtml(`<pre class="muted">${message.isError ? "✗" : "✓"} ${escapeHtml(message.toolName)}</pre>`);
    } else if (message.role === "compactionSummary") {
      outHtml('<pre class="muted">— earlier context summarized —</pre>');
    }
  }
}

async function waitTurn() {
  const state = await api(`/v1/sessions/${sessionId}`);
  if (state.ok && state.body.status === "idle") return;
  await new Promise((resolve) => { resolveTurn = resolve; });
}

function blankLine() {
  out(" ");
}

// The server may have restarted: the active session is gone, but the persisted
// session can be resumed under the same id. The old EventSource got a 404 while
// the session was gone, which closes it for good, so always open a fresh stream.
async function reattach() {
  const listing = await api("/v1/sessions");
  if (!listing.ok) return false;
  const entry = listing.body.sessions.find((e) => e.workspaceId === workspaceId);
  if (!entry) return false;
  if (entry.active) {
    sessionId = entry.session.id;
  } else {
    const response = await jsonPost("/v1/sessions", {
      workspaceId,
      resumeSessionId: sessionId,
    });
    if (!response.ok) return false;
    sessionId = response.body.id;
  }
  stream?.close();
  openStream();
  return true;
}

async function chatLoop() {
  for (;;) {
    blankLine();
    const message = await ask("> ");
    if (message === undefined || message.trim().length === 0) continue;
    blankLine();
    let response = await jsonPost(`/v1/sessions/${sessionId}/turns`, {
      message,
      clientId,
    });
    if (response.status === 404 && response.body?.error === "session_not_found") {
      if (await reattach()) {
        response = await jsonPost(`/v1/sessions/${sessionId}/turns`, {
          message,
          clientId,
        });
      }
    }
    if (!response.ok) {
      out(`[turn rejected: ${response.body?.error ?? response.status}]`);
      continue;
    }
    await waitTurn();
  }
}

stopButton.addEventListener("click", () => {
  if (currentTurnId !== null) {
    void api(`/v1/sessions/${sessionId}/turns/${currentTurnId}/abort`, { method: "POST" });
  }
});

async function boot() {
  const listing = await api("/v1/sessions");
  if (!listing.ok) {
    out(`[cannot reach the adapter: ${listing.status}]`);
    return;
  }
  const entries = listing.body.sessions;
  let entry;
  if (entries.length === 1) {
    entry = entries[0];
  } else {
    entries.forEach((e, index) => {
      out(`${index + 1}. ${e.workspaceId}${e.active ? " (active)" : ""}`);
    });
    for (;;) {
      const choice = await ask("workspace # > ");
      const selected = entries[Number(choice) - 1];
      if (choice !== undefined && selected) {
        entry = selected;
        break;
      }
    }
  }
  workspaceId = entry.workspaceId;
  out(`workspace: ${workspaceId}`);

  let createResponse;
  if (entry.active) {
    sessionId = entry.session.id;
    out(`attached to active session ${sessionId}`);
  } else if (entry.session) {
    const summary = entry.session;
    const label = summary.name
      ?? (summary.firstMessage ? `"${truncate(summary.firstMessage, 60)}"` : "untitled");
    out(`resuming previous session: ${label} (${summary.messageCount} messages)`);
    createResponse = await jsonPost("/v1/sessions", {
      workspaceId: entry.workspaceId,
      resumeSessionId: summary.id,
    });
  } else {
    createResponse = await jsonPost("/v1/sessions", { workspaceId: entry.workspaceId });
  }
  if (createResponse !== undefined) {
    if (!createResponse.ok) {
      out(`[session error: ${createResponse.body?.error ?? createResponse.status}]`);
      return;
    }
    sessionId = createResponse.body.id;
    out(createResponse.body.resumed
      ? `resumed session ${sessionId}`
      : `new session ${sessionId}`);
  }

  openStream();
  await renderHistory();
  // The replayed working status may have landed above the history it precedes; move it
  // to the live edge so it stays visible next to the streaming content.
  const working = document.getElementById("working");
  if (working) {
    working.parentElement?.appendChild(working);
    term.scroll_to_bottom();
  }
  await chatLoop();
}

void boot();
