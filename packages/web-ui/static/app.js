import { Termino } from "./termino.js";

const term = Termino(document.getElementById("terminal"));
const stopButton = document.getElementById("stop");
const uploadButton = document.getElementById("upload");
const fileInput = document.getElementById("file-input");
const inputElement = document.querySelector(".termino-input");
term.disable_input();

// Upload and Stop are a single header slot: uploading is useless mid-turn (the
// agent reads files only at the next prompt), so show Stop while a turn runs.
const showIdleControls = () => {
  uploadButton.hidden = false;
  stopButton.hidden = true;
};
const showRunningControls = () => {
  uploadButton.hidden = true;
  stopButton.hidden = false;
};

// crypto.randomUUID needs a secure context (HTTPS or localhost); plain-http LAN
// hosts lack it, so fall back to a v4 UUID built from getRandomValues.
const makeClientId = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

// Identifies this page to the adapter so it can skip echoing our own input.
// Persisted per tab so a refresh mid-dialog stays the submitter; new tabs observe.
let clientId = sessionStorage.getItem("clientId");
if (!clientId) {
  clientId = crypto.randomUUID ? crypto.randomUUID() : makeClientId();
  sessionStorage.setItem("clientId", clientId);
}

let sessionId = null;
let workspaceId = null;
let stream = null;
let currentTurnId = null;
let workingPhase = null;
let workingSeconds = null;
let resolveTurn = null;
let streamBlock = null;
let streamText = "";
// Last streamed text block, kept across outHtml calls (which reset the active
// streamBlock) so the final message can still be linkified on completion.
let lastTextBlock = null;
let reconnectNoted = false;
let dialogChain = Promise.resolve();
let dialogOpen = false;
// Only the page that submitted the running turn answers its dialogs; other pages
// observe read-only until the turn ends.
let currentTurnClientId = null;
let isDialogObserver = false;
// Last dialog shown, so a reconnect replay of the same request is skipped.
let lastDialogKey = null;
// Uploaded file paths awaiting the next submitted message, so the agent learns
// about them in context instead of only from the transcript line.
let pendingUploads = [];
const USER_PROMPT = "❯ ";
// A pending term.input()'s user prompt plus its preceding blank line; re-anchored to
// the bottom on each append so the shared transcript cannot push the idle client's
// prompt (and its spacing) up.
let pendingPrompt = null;
// The adapter pings every 30s; 3 missed pings mean the stream is stale.
const STALE_MS = 90_000;
const WATCHDOG_MS = 15_000;
const RECONNECT_GAP_MS = 10_000;
let lastEventAt = 0;
let reconnectDue = false;
let reconnecting = false;
let lastReconnectAt = 0;
let watchdog = null;
const WORKING_PHASE_LABELS = {
  processing: "Working",
  reading: "Reading",
  thinking: "Thinking",
  output: "Writing",
  executing: "Running",
  compaction: "Compacting",
};

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

// A backticked span counts as a file only when it looks like a path: no
// whitespace or shell/URL metacharacters, and either a directory separator
// or a dotted name ("report.pdf"; a bare ".md" is a format mention).
function isFilePathToken(text) {
  if (/\s/.test(text)) return false;
  if (/[#?@<>=&|:]/.test(text)) return false;
  return text.includes("/") || /^[^\s.].*\.[A-Za-z]{1,10}$/.test(text);
}

// Convert backticked and /workspace/... file paths in assistant text into share
// links. The agent cites files by workspace-relative path; the page owns the URL.
function linkifyFilePaths(text, workspaceId) {
  const base = `/share/${workspaceId}/`;
  const pattern = /`([^`]+)`|\/workspace\/([^\s`]+)/g;
  let html = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    html += escapeHtml(text.slice(last, match.index));
    const raw = match[1] ?? match[2];
    if (match[1] !== undefined && !isFilePathToken(match[1])) {
      html += escapeHtml(match[0]);
    } else {
      // Normalize an absolute container path back to workspace-relative and drop
      // trailing sentence punctuation the agent may have written after the path.
      const rel = raw.replace(/^\/workspace\//, "").replace(/[.,;:!?)]+$/, "");
      const href = base + rel.split("/").map((segment) => encodeURIComponent(segment)).join("/");
      html += `<a href="${href}" title="${escapeHtml(href)}">${escapeHtml(match[0])}</a>`;
    }
    last = match.index + match[0].length;
  }
  html += escapeHtml(text.slice(last));
  return html;
}

// Keep a pending prompt (an idle client's "> ") pinned above the input box when new
// content appends below it; appendChild on an existing child moves it to the end.
function reAnchorPrompt() {
  if (!pendingPrompt) return;
  const consoleElement = document.querySelector(".termino-console");
  if (pendingPrompt[pendingPrompt.length - 1] === consoleElement.lastElementChild) return;
  for (const el of pendingPrompt) consoleElement.appendChild(el);
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
  reAnchorPrompt();
  term.scroll_to_bottom();
}

function out(text) {
  outHtml(`<pre>${escapeHtml(text)}</pre>`);
}

function outMuted(text) {
  outHtml(`<pre class="muted">${escapeHtml(text)}</pre>`);
}

function outUser(text) {
  outHtml(`<pre class="user-message">${escapeHtml(`${USER_PROMPT}${text}`)}</pre>`);
}

async function ask(question, className = null) {
  term.enable_input();
  document.querySelector(".termino-input").focus();
  const prompt = term.input(escapeHtml(question));
  const promptElement = document.querySelector(".termino-console").lastElementChild;
  if (className) {
    promptElement.classList.add(className);
    // The class changes the prompt height after Termino's initial scroll.
    term.scroll_to_bottom();
  }
  // Keep chatLoop's blank line (the element right above the prompt) with it so the
  // pair stays together when re-anchored; dialogs and the picker have no blank.
  const prev = promptElement.previousElementSibling;
  pendingPrompt = prev && /^\s*$/.test(prev.textContent) ? [prev, promptElement] : [promptElement];
  try {
    return await prompt;
  } finally {
    pendingPrompt = null;
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
  const indicator = document.createElement("pre");
  indicator.className = "indicator";
  indicator.id = "indicator";
  indicator.textContent = text;
  document.querySelector(".termino-console").appendChild(indicator);
  streamBlock = null;
  streamText = "";
  reAnchorPrompt();
  term.scroll_to_bottom();
}

function hideIndicator() {
  document.getElementById("indicator")?.remove();
}

// The agent's own working status arrives every second as a ui_event; show it in the
// disabled input's placeholder so it stays pinned at the bottom instead of being
// pushed up by the streaming transcript.
function showWorking(message) {
  inputElement.placeholder = message;
}

function hideWorking() {
  inputElement.placeholder = "";
}

function renderWorkingStatus() {
  if (workingPhase === null) {
    hideWorking();
    return;
  }
  const label = WORKING_PHASE_LABELS[workingPhase] ?? WORKING_PHASE_LABELS.processing;
  showWorking(workingSeconds === null ? label : `${label} · ${workingSeconds}s`);
}

// Another page's dialog: observe read-only until the turn ends — cancel any pending
// main prompt and lock the input. Stop stays visible so an orphaned dialog can be
// aborted from any page.
function becomeDialogObserver() {
  if (isDialogObserver) return;
  isDialogObserver = true;
  term.cancel_input();
  term.disable_input();
}

function renderDialogReadOnly(request) {
  if (request.method === "confirm") {
    out(`! ${request.title}`);
    if (request.message) out(request.message);
  } else {
    out(request.title);
    if (request.method === "select" && request.options) {
      request.options.forEach((option, index) => out(`  ${index + 1}. ${option}`));
    }
  }
  outHtml('<pre class="muted">[waiting for the master client to answer]</pre>');
}

function appendDelta(delta) {
  if (!streamBlock) {
    streamText = "";
    streamBlock = document.createElement("pre");
    document.querySelector(".termino-console").appendChild(streamBlock);
  }
  streamText += delta;
  streamBlock.textContent = streamText;
  lastTextBlock = streamBlock;
  reAnchorPrompt();
  term.scroll_to_bottom();
}

function endStream() {
  streamBlock = null;
  lastTextBlock = null;
  streamText = "";
}

// --- events ------------------------------------------------------------

function onTurn(event) {
  if (event.status === "running" || event.status === "aborting") {
    currentTurnId = event.turnId;
    if (event.status === "running") {
      currentTurnClientId = event.clientId ?? null;
      workingPhase = "reading";
      workingSeconds = null;
      renderWorkingStatus();
    }
    showRunningControls();
    // Another client submitted the turn: show its input (ours is already in the
    // prompt line).
    if (
      event.status === "running"
      && event.message !== undefined
      && event.clientId !== clientId
    ) {
      blankLine();
      outUser(event.message);
      blankLine();
    }
    return;
  }
  workingPhase = null;
  workingSeconds = null;
  hideIndicator();
  hideWorking();
  if (event.status === "completed" && lastTextBlock) {
    lastTextBlock.innerHTML = linkifyFilePaths(lastTextBlock.textContent, workspaceId);
  }
  endStream();
  isDialogObserver = false;
  currentTurnClientId = null;
  showIdleControls();
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
  // A reconnect replays pending ui_requests; skip one we already showed.
  const key = `${turnId}:${request.id}`;
  if (key === lastDialogKey) return;
  lastDialogKey = key;
  // Only the page that submitted the running turn answers its dialogs; other pages see
  // them read-only and stay out of the input flow.
  if (currentTurnClientId !== clientId) {
    becomeDialogObserver();
    renderDialogReadOnly(request);
    return;
  }
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
    lastEventAt = Date.now();
    reconnectDue = false;
    document.getElementById("reconnect-notice")?.remove();
    reconnectNoted = false;
  });
  source.addEventListener("error", () => {
    // A stale error from a replaced stream must not clobber the current one.
    if (stream !== source) return;
    // Close instead of letting EventSource retry: its auto-reconnect is a bare
    // URL reconnect that can stall or stop (laptop sleep, silent drops) and
    // can't resume a restarted session. reattach() reopens / resumes instead.
    source.close();
    stream = null;
    reconnectDue = true;
    void reconnect();
  });
  source.addEventListener("ping", () => { lastEventAt = Date.now(); });
  source.addEventListener("turn", (e) => onTurn(JSON.parse(e.data)));
  source.addEventListener("activity", (e) => {
    const event = JSON.parse(e.data);
    if (event.turnId !== currentTurnId) return;
    workingPhase = event.phase;
    renderWorkingStatus();
  });
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
        const match = /Working \((\d+)s\b/.exec(event.message);
        workingSeconds = match ? Number(match[1]) : null;
      } else {
        workingSeconds = null;
      }
      renderWorkingStatus();
    }
  });
}

// Only shown once a reconnect attempt has failed, so a transient blip that
// recovers instantly never flashes a notice.
function showReconnectNotice() {
  if (!reconnectNoted) {
    outHtml('<pre id="reconnect-notice" class="muted">[connection lost — retrying…]</pre>');
    reconnectNoted = true;
  }
}

async function reconnect() {
  if (reconnecting) return;
  if (Date.now() - lastReconnectAt < RECONNECT_GAP_MS) {
    reconnectDue = true;
    return;
  }
  reconnecting = true;
  lastReconnectAt = Date.now();
  try {
    stream?.close();
    stream = null;
    if (!(await reattach())) showReconnectNotice();
  } finally {
    reconnecting = false;
  }
}

function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (reconnectDue || Date.now() - lastEventAt > STALE_MS) {
      reconnectDue = false;
      void reconnect();
    }
  }, WATCHDOG_MS);
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
        outUser(block.text);
        blankLine();
      }
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text") {
          outHtml(`<pre>${linkifyFilePaths(block.text, workspaceId)}</pre>`);
        } else {
          outHtml(`<pre class="muted">⚙ ${escapeHtml(toolSummary(block.name, block.arguments))}</pre>`);
        }
      }
    } else if (message.role === "toolResult") {
      outHtml(`<pre class="muted">${message.isError ? "✗" : "✓"} ${escapeHtml(message.toolName)}</pre>`);
    } else if (message.role === "compactionSummary") {
      outHtml('<pre class="muted">— earlier context summarized —</pre>');
    }
  }
}

async function waitTurn() {
  // Arm the resolver before the GET so a turn that ends during the fetch is not
  // missed; the GET only decides whether we need to park at all.
  const parked = new Promise((resolve) => { resolveTurn = resolve; });
  const state = await api(`/v1/sessions/${sessionId}`);
  if (state.ok && state.body.status === "idle") return;
  await parked;
}

function blankLine() {
  out(" ");
}

// The server may have restarted: the active session is gone, but the persisted
// session can be resumed under the same id. The old EventSource got a 404 while
// the session was gone, which closes it for good, so always open a fresh stream.
async function reattach() {
  const listing = await api(`/v1/sessions?workspaceId=${workspaceId}`);
  if (!listing.ok) return false;
  const entry = listing.body.sessions[0];
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
    // Await any in-flight turn so a dialog prompt is the only pending input;
    // a second pending ask resolves on the same Enter and disables the input.
    await waitTurn();
    blankLine();
    let message = await ask(USER_PROMPT, "user-message");
    if (message === undefined || message.trim().length === 0) continue;
    if (pendingUploads.length > 0) {
      message = `[Uploaded files: ${pendingUploads.join(", ")}]\n${message}`;
      pendingUploads = [];
    }
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
    // The loop's top waitTurn() awaits the turn just submitted.
  }
}

stopButton.addEventListener("click", () => {
  if (currentTurnId !== null) {
    void api(`/v1/sessions/${sessionId}/turns/${currentTurnId}/abort`, { method: "POST" });
  }
});

uploadButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const selected = [...fileInput.files];
  fileInput.value = "";
  if (selected.length === 0) return;
  const form = new FormData();
  for (const file of selected) form.append("files", file);
  const response = await api(`/v1/workspaces/${workspaceId}/files`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    out(`[upload failed: ${response.body?.error ?? response.status}]`);
    return;
  }
  for (const file of response.body.files) {
    pendingUploads.push(file.path);
    outHtml(
      `<pre class="muted">📎 uploaded: ${linkifyFilePaths(`\`${file.path}\``, workspaceId)}</pre>`,
    );
  }
});

async function boot() {
  // The workspace secret comes from the URL (/chat/<workspaceId>); the server serves
  // the page only for a configured id, so a load here implies a valid one.
  workspaceId = location.pathname.split("/")[2];
  if (!workspaceId) {
    out("[missing workspace in URL]");
    return;
  }
  const listing = await api(`/v1/sessions?workspaceId=${workspaceId}`);
  if (!listing.ok) {
    out(`[cannot reach the adapter: ${listing.status}]`);
    return;
  }
  const entry = listing.body.sessions[0];
  if (!entry) {
    out(`[workspace ${workspaceId} not found]`);
    return;
  }
  showIdleControls();
  outMuted(`workspace: ${workspaceId}`);

  let createResponse;
  if (entry.active) {
    sessionId = entry.session.id;
    outMuted(`attached to active session ${sessionId}`);
  } else if (entry.session) {
    const summary = entry.session;
    const label = summary.name
      ?? (summary.firstMessage ? `"${truncate(summary.firstMessage, 60)}"` : "untitled");
    outMuted(`resuming previous session: ${label} (${summary.messageCount} messages)`);
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
    outMuted(createResponse.body.resumed
      ? `resumed session ${sessionId}`
      : `new session ${sessionId}`);
  }

  // Render history before opening the stream: the replay of an in-flight turn
  // (running event + pending dialog) then lands below the transcript instead of
  // being pushed above it — and out of view — by the history render.
  await renderHistory();
  openStream();
  startWatchdog();
  await chatLoop();
}

void boot();
