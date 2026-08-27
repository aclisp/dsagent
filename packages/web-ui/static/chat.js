import { marked } from "/marked.esm.js";

marked.setOptions({ gfm: true });

const configuredAgentName = document.querySelector('meta[name="chat-agent-name"]')?.content;
if (!configuredAgentName) throw new Error("Chat agent name is not configured");
const agentName = configuredAgentName;
const appElement = document.getElementById("chat-app");
const fatalScreen = document.getElementById("fatal-screen");
const statusElement = document.getElementById("agent-status");
const statusText = document.getElementById("agent-status-text");
const connectionBanner = document.getElementById("connection-banner");
const scroller = document.getElementById("message-scroller");
const messagesElement = document.getElementById("messages");
const jumpLatestButton = document.getElementById("jump-latest");
const scrollEarliestHotspot = document.getElementById("scroll-earliest");
const composerElement = document.querySelector(".composer");
const composerForm = document.getElementById("composer-form");
const messageInput = document.getElementById("message-input");
const uploadButton = document.getElementById("upload-button");
const fileInput = document.getElementById("file-input");
const actionButton = document.getElementById("action-button");
const pendingAttachmentsElement = document.getElementById("pending-attachments");
const modalBackdrop = document.getElementById("modal-backdrop");
const modalTitle = document.getElementById("modal-title");
const modalMessage = document.getElementById("modal-message");
const modalControl = document.getElementById("modal-control");
const modalObserver = document.getElementById("modal-observer");
const modalActions = document.getElementById("modal-actions");

const STALE_MS = 90_000;
const WATCHDOG_MS = 15_000;
const RECONNECT_GAP_MS = 10_000;
const NEAR_BOTTOM_PX = 90;
const MAX_INPUT_HEIGHT = 88;
const HEADER_GESTURE_THRESHOLD_PX = 14;
const TIME_SEPARATOR_INTERVAL_MS = 5 * 60_000;
const RETAINED_TURN_TARGET = 100;
const TURN_TRIM_BUFFER = 20;
const RETAINED_TIMELINE_ITEM_TARGET = 500;
const TIMELINE_ITEM_TRIM_BUFFER = 100;
const UPLOAD_PREFIX = /^\[Uploaded files: (.*)\]\n?([\s\S]*)$/;
const SCHEDULED_TASK_PREFIX = /^\[Scheduled task: [a-z0-9]+(?:-[a-z0-9]+)*(?:; source=[a-z0-9][a-z0-9-]*)?\]\n\n([\s\S]*)$/;
const IM_MESSAGE_PREFIX = /^\[IM message: (group|direct)=[a-z0-9][a-z0-9-]*; sender=[a-z0-9][a-z0-9-]*\]\r?\n\r?\n([\s\S]*)$/;
const SCHEDULED_TASK_SUMMARY_LENGTH = 120;
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const state = {
  workspaceId: null,
  sessionId: null,
  stream: null,
  clientId: null,
  currentTurnId: null,
  currentTurnClientId: null,
  lastTerminalTurnId: null,
  observedSubmissionTurnId: null,
  running: false,
  aborting: false,
  submitting: false,
  connected: false,
  booting: true,
  uploading: false,
  workingPhase: "working",
  workingSeconds: null,
  liveTurn: null,
  pendingUploads: [],
  uploadingFiles: [],
  composing: false,
  followLatest: true,
  jumpingToLatest: false,
  scrollingToEarliest: false,
  scrollIntent: null,
  lastTimeSeparatorTimestamp: null,
  lastRenderedUserTurnId: null,
  lastAssistantText: "",
  historyLastTurn: null,
  historyTurnPendingBinding: false,
  attachedSessionStatus: null,
  currentRequestKey: null,
  respondingRequestKey: null,
  reconnecting: false,
  reconnectDue: false,
  historySyncDue: false,
  lastReconnectAt: 0,
  lastEventAt: 0,
  watchdog: null,
  timelineRetentionReady: false,
  timelineTargetTurns: RETAINED_TURN_TARGET,
  timelineMaxTurns: RETAINED_TURN_TARGET + TURN_TRIM_BUFFER,
  timelineTargetItems: RETAINED_TIMELINE_ITEM_TARGET,
  timelineMaxItems: RETAINED_TIMELINE_ITEM_TARGET + TIMELINE_ITEM_TRIM_BUFFER,
  trimmedTurnCount: 0,
  trimmingTimeline: false,
};

function makeClientId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

state.clientId = sessionStorage.getItem("chatClientId");
if (!state.clientId) {
  state.clientId = crypto.randomUUID ? crypto.randomUUID() : makeClientId();
  sessionStorage.setItem("chatClientId", state.clientId);
}

let followLatestFrame = null;
let pointerScrollTop = null;
let previousTouchY = null;
let headerGestureDistance = 0;
const compactHeaderMedia = window.matchMedia(
  "(orientation: landscape) and (max-height: 500px) and (pointer: coarse)",
);

async function api(path, options = {}) {
  try {
    const response = await fetch(path, options);
    const text = await response.text();
    let body = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: { error: String(error) } };
  }
}

function jsonPost(path, body) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function isNearBottom() {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM_PX;
}

function scheduleFollowLatest() {
  if (!state.followLatest || followLatestFrame !== null) return;
  followLatestFrame = requestAnimationFrame(() => {
    followLatestFrame = null;
    if (!state.followLatest) return;
    scroller.scrollTop = scroller.scrollHeight;
    jumpLatestButton.hidden = true;
  });
}

function afterContentChange(force = false) {
  if (force) {
    state.followLatest = true;
    state.jumpingToLatest = false;
    state.scrollingToEarliest = false;
    state.scrollIntent = null;
  }
  trimTimelineIfNeeded();
  if (state.followLatest) {
    scheduleFollowLatest();
  } else {
    jumpLatestButton.hidden = false;
  }
}

function stopFollowingLatest() {
  if (scroller.scrollHeight <= scroller.clientHeight) return;
  state.followLatest = false;
  state.jumpingToLatest = false;
  jumpLatestButton.hidden = false;
}

function isBackForwardNavigation() {
  return performance.getEntriesByType("navigation")[0]?.type === "back_forward";
}

function positionJumpButton() {
  jumpLatestButton.style.bottom = `${composerElement.offsetHeight + 14}px`;
}

function setHeaderCollapsed(collapsed) {
  appElement.classList.toggle(
    "is-header-collapsed",
    collapsed && compactHeaderMedia.matches,
  );
}

function updateHeaderFromTouch(delta) {
  if (!compactHeaderMedia.matches || delta === 0) return;
  if (Math.sign(delta) !== Math.sign(headerGestureDistance)) headerGestureDistance = 0;
  headerGestureDistance += delta;
  if (
    headerGestureDistance >= HEADER_GESTURE_THRESHOLD_PX
    && scroller.scrollHeight > scroller.clientHeight
    && scroller.scrollTop > 0
  ) {
    setHeaderCollapsed(true);
    headerGestureDistance = 0;
  } else if (headerGestureDistance <= -HEADER_GESTURE_THRESHOLD_PX) {
    setHeaderCollapsed(false);
    headerGestureDistance = 0;
  }
}

function scrollToEarliest() {
  setHeaderCollapsed(false);
  if (scroller.scrollHeight <= scroller.clientHeight) return;
  state.followLatest = false;
  state.jumpingToLatest = false;
  state.scrollIntent = "older";
  jumpLatestButton.hidden = false;
  if (scroller.scrollTop <= 1) {
    state.scrollingToEarliest = false;
    return;
  }
  state.scrollingToEarliest = true;
  scroller.scrollTo({ top: 0, behavior: "smooth" });
}

function resetTimeline() {
  messagesElement.replaceChildren();
  state.lastTimeSeparatorTimestamp = null;
  state.lastRenderedUserTurnId = null;
  state.lastAssistantText = "";
  state.historyLastTurn = null;
  state.historyTurnPendingBinding = false;
  state.timelineRetentionReady = false;
  state.timelineTargetTurns = RETAINED_TURN_TARGET;
  state.timelineMaxTurns = RETAINED_TURN_TARGET + TURN_TRIM_BUFFER;
  state.timelineTargetItems = RETAINED_TIMELINE_ITEM_TARGET;
  state.timelineMaxItems = RETAINED_TIMELINE_ITEM_TARGET + TIMELINE_ITEM_TRIM_BUFFER;
  state.trimmedTurnCount = 0;
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function timeSeparatorLabel(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  if (localDateKey(timestamp) === localDateKey(today.getTime())) return timeLabel(timestamp);
  const datePart = date.getFullYear() === today.getFullYear()
    ? `${date.getMonth() + 1} 月 ${date.getDate()} 日`
    : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return `${datePart} ${timeLabel(timestamp)}`;
}

function timeLabel(timestamp) {
  return timeFormatter.format(new Date(timestamp));
}

function createTimeSeparator(timestamp) {
  const separator = document.createElement("div");
  separator.className = "time-separator";
  separator.dataset.timestamp = String(timestamp);
  separator.textContent = timeSeparatorLabel(timestamp);
  return separator;
}

function ensureTimeSeparator(timestamp) {
  const previousTimestamp = state.lastTimeSeparatorTimestamp;
  const changedDate = previousTimestamp === null
    || localDateKey(timestamp) !== localDateKey(previousTimestamp);
  const separatedByTime = previousTimestamp === null
    || timestamp - previousTimestamp >= TIME_SEPARATOR_INTERVAL_MS;
  if (changedDate || separatedByTime) {
    messagesElement.appendChild(createTimeSeparator(timestamp));
    state.lastTimeSeparatorTimestamp = timestamp;
  }
}

function timelineUserRows(children = [...messagesElement.children]) {
  return children.filter(
    (element) => element.dataset.role === "user",
  );
}

function configureTimelineRetention() {
  const turnCount = timelineUserRows().length;
  const itemCount = messagesElement.childElementCount;
  state.timelineTargetTurns = Math.max(RETAINED_TURN_TARGET, turnCount);
  state.timelineMaxTurns = state.timelineTargetTurns + TURN_TRIM_BUFFER;
  state.timelineTargetItems = Math.max(RETAINED_TIMELINE_ITEM_TARGET, itemCount);
  state.timelineMaxItems = state.timelineTargetItems + TIMELINE_ITEM_TRIM_BUFFER;
  state.timelineRetentionReady = true;
}

function createTimelineRetentionNotice() {
  const notice = document.createElement("div");
  notice.className = "system-notice timeline-retention-notice";
  notice.textContent = `为保持页面流畅，已收起 ${state.trimmedTurnCount} 轮较早对话。刷新页面可重新同步当前历史。`;
  return notice;
}

function trimTimelineIfNeeded() {
  if (!state.timelineRetentionReady || state.trimmingTimeline) return false;

  const children = [...messagesElement.children];
  const users = timelineUserRows(children);
  if (
    users.length <= state.timelineMaxTurns
    && children.length <= state.timelineMaxItems
  ) return false;

  let boundaryPosition = Math.max(0, users.length - state.timelineTargetTurns);
  const minimumItemIndex = Math.max(0, children.length - state.timelineTargetItems);
  while (
    boundaryPosition < users.length - 1
    && children.indexOf(users[boundaryPosition]) < minimumItemIndex
  ) boundaryPosition += 1;
  if (boundaryPosition <= 0) return false;

  const boundary = users[boundaryPosition];
  const boundaryIndex = children.indexOf(boundary);
  const removable = children.slice(0, boundaryIndex);
  const removedTurns = timelineUserRows(removable).length;
  if (removedTurns === 0 || pointerScrollTop !== null || previousTouchY !== null) return false;

  if (!state.followLatest) {
    const lastRemovable = removable.at(-1);
    if (
      lastRemovable
      && lastRemovable.getBoundingClientRect().bottom
        > scroller.getBoundingClientRect().top + 1
    ) return false;
  }

  state.trimmingTimeline = true;
  try {
    const anchorTop = boundary.getBoundingClientRect().top;
    for (const element of removable) element.remove();
    state.trimmedTurnCount += removedTurns;

    const timestamp = Number(boundary.dataset.timestamp);
    const separator = createTimeSeparator(Number.isFinite(timestamp) ? timestamp : Date.now());
    messagesElement.insertBefore(separator, boundary);
    messagesElement.insertBefore(createTimelineRetentionNotice(), separator);
    const latestSeparator = [...messagesElement.querySelectorAll(".time-separator")].at(-1);
    const latestTimestamp = Number(latestSeparator?.dataset.timestamp);
    state.lastTimeSeparatorTimestamp = Number.isFinite(latestTimestamp)
      ? latestTimestamp
      : null;

    const anchorOffset = boundary.getBoundingClientRect().top - anchorTop;
    if (anchorOffset !== 0) scroller.scrollTop += anchorOffset;
    return true;
  } finally {
    state.trimmingTimeline = false;
  }
}

function isFilePathToken(text) {
  if (/\s/.test(text)) return false;
  if (/[#?@<>=&|:]/.test(text)) return false;
  return text.includes("/") || /^[^\s.].*\.[A-Za-z]{1,10}$/.test(text);
}

function shareHref(rawPath) {
  const relative = rawPath
    .replace(/^\/workspace\//, "")
    .replace(/[.,;:!?)]+$/, "");
  return `/share/${state.workspaceId}/${relative
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function enhanceFileLinks(root) {
  for (const code of root.querySelectorAll("code")) {
    if (code.closest("pre") || code.closest("a")) continue;
    const value = code.textContent ?? "";
    if (!isFilePathToken(value)) continue;
    const link = document.createElement("a");
    link.href = shareHref(value);
    code.replaceWith(link);
    link.appendChild(code);
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest("a, code, pre")) textNodes.push(node);
  }
  const pattern = /\/workspace\/([^\s<]+)/g;
  for (const node of textNodes) {
    const text = node.textContent ?? "";
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      fragment.append(text.slice(lastIndex, match.index));
      const raw = match[0];
      const clean = raw.replace(/[.,;:!?)]+$/, "");
      const trailing = raw.slice(clean.length);
      const link = document.createElement("a");
      link.href = shareHref(clean);
      link.textContent = clean;
      fragment.append(link, trailing);
      lastIndex = match.index + raw.length;
    }
    fragment.append(text.slice(lastIndex));
    node.replaceWith(fragment);
  }
}

function renderAssistantMarkdown(element, text) {
  element.innerHTML = marked.parse(text);
  enhanceFileLinks(element);
}

function parseUploadedMessage(raw) {
  const match = UPLOAD_PREFIX.exec(raw);
  if (!match) return { text: raw, attachments: [] };
  const attachments = match[1]
    .split(", ")
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => ({ name: path.split("/").pop() || path, path }));
  return { text: match[2], attachments };
}

function parseScheduledTaskMessage(raw) {
  const match = SCHEDULED_TASK_PREFIX.exec(raw);
  if (!match) return null;
  const firstLine = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  const normalized = firstLine.replace(/\s+/g, " ");
  const characters = [...normalized];
  return characters.length <= SCHEDULED_TASK_SUMMARY_LENGTH
    ? normalized
    : `${characters.slice(0, SCHEDULED_TASK_SUMMARY_LENGTH).join("")}…`;
}

function parseImMessagePrompt(raw) {
  const match = IM_MESSAGE_PREFIX.exec(raw);
  if (!match) return null;
  return { text: match[2], type: match[1] };
}

function appendMessageSource(meta, type) {
  const source = document.createElement("span");
  source.className = "message-source";
  source.textContent = type === "direct" ? "单聊" : "群聊";
  meta.appendChild(source);
}

function appendScheduledTaskEvent(summary, timestamp = Date.now()) {
  ensureTimeSeparator(timestamp);
  const event = document.createElement("article");
  event.className = "scheduled-task-event";
  event.dataset.role = "user";
  event.dataset.timestamp = String(timestamp);
  const title = document.createElement("strong");
  title.textContent = "定时任务";
  const content = document.createElement("span");
  content.textContent = summary;
  event.append(title, content);
  messagesElement.appendChild(event);
  afterContentChange();
  return event;
}

function appendUserTimelineMessage(raw, timestamp = Date.now()) {
  const scheduledSummary = parseScheduledTaskMessage(raw);
  if (scheduledSummary !== null) {
    return appendScheduledTaskEvent(scheduledSummary, timestamp);
  }
  const imMessage = parseImMessagePrompt(raw);
  const message = appendMessage(
    "user",
    imMessage?.text ?? raw,
    timestamp,
  );
  if (imMessage !== null) {
    appendMessageSource(message.meta, imMessage.type);
    afterContentChange();
  }
  return message;
}

function createAttachmentList(attachments) {
  if (attachments.length === 0) return null;
  const list = document.createElement("div");
  list.className = "attachment-list";
  for (const attachment of attachments) {
    const link = document.createElement("a");
    link.className = "attachment-card";
    link.href = shareHref(attachment.path);
    const icon = document.createElement("span");
    icon.className = "attachment-icon";
    icon.textContent = "📎";
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = attachment.name;
    link.append(icon, name);
    list.appendChild(link);
  }
  return list;
}

function createMessageRow(role, timestamp) {
  ensureTimeSeparator(timestamp);
  const row = document.createElement("article");
  row.className = `message-row is-${role}`;
  row.dataset.role = role;
  row.dataset.timestamp = String(timestamp);
  if (role === "assistant") {
    const avatar = document.createElement("img");
    avatar.className = "message-avatar";
    avatar.src = "/favicon.png";
    avatar.alt = agentName;
    row.appendChild(avatar);
  }
  const column = document.createElement("div");
  column.className = "message-column";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  column.append(bubble, meta);
  row.appendChild(column);
  messagesElement.appendChild(row);
  return { row, bubble, meta };
}

function appendMessage(role, rawText, timestamp = Date.now(), options = {}) {
  const parts = role === "user"
    ? parseUploadedMessage(rawText)
    : { text: rawText, attachments: options.attachments ?? [] };
  const elements = createMessageRow(role, timestamp);
  if (role === "assistant") {
    renderAssistantMarkdown(elements.bubble, parts.text);
    state.lastAssistantText = parts.text;
  } else {
    const text = document.createElement("div");
    text.className = "plain-text";
    text.textContent = parts.text;
    if (parts.text.length > 0) elements.bubble.appendChild(text);
  }
  const attachmentList = createAttachmentList(parts.attachments);
  if (attachmentList) elements.bubble.appendChild(attachmentList);
  afterContentChange(options.forceScroll);
  return { ...elements, text: parts.text, rawText };
}

function appendSystemNotice(text, kind = "info", timestamp = Date.now(), options = {}) {
  if (options.showTimeSeparator !== false) ensureTimeSeparator(timestamp);
  const notice = document.createElement("div");
  notice.className = `system-notice${kind === "info" ? "" : ` is-${kind}`}`;
  notice.textContent = text;
  messagesElement.appendChild(notice);
  afterContentChange();
  return notice;
}

function appendTyping(turn) {
  if (turn.typingRow || turn.firstDeltaSeen) return;
  const elements = createMessageRow("assistant", Date.now());
  elements.row.classList.add("typing-row");
  elements.bubble.setAttribute("aria-label", `${agentName} 正在输入`);
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement("span");
    dot.className = "typing-dot";
    elements.bubble.appendChild(dot);
  }
  turn.typingRow = elements;
  afterContentChange();
}

function moveTypingToBottom(turn) {
  if (!turn.typingRow) return;
  messagesElement.appendChild(turn.typingRow.row);
  afterContentChange();
}

function removeTyping(turn) {
  turn?.typingRow?.row.remove();
  if (turn) turn.typingRow = null;
}

function discardLiveTurn() {
  const renderFrame = state.liveTurn?.assistantBubble?.renderFrame;
  if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
  removeTyping(state.liveTurn);
  state.liveTurn = null;
}

function streamAssistantDelta(event) {
  if (
    typeof event.delta !== "string"
    || typeof event.turnId !== "string"
    || event.turnId !== state.currentTurnId
  ) return;
  const turn = ensureLiveTurn(event.turnId);
  if (!turn) return;
  let message = turn.assistantBubble;
  if (!message) {
    if (turn.typingRow) {
      message = turn.typingRow;
      message.row.classList.remove("typing-row");
      message.bubble.removeAttribute("aria-label");
      message.bubble.replaceChildren();
      turn.typingRow = null;
    } else {
      message = appendMessage("assistant", "", Date.now());
    }
    message.text = "";
    turn.assistantBubble = message;
  }
  turn.firstDeltaSeen = true;
  message.text += event.delta;
  state.lastAssistantText = message.text;
  if (message.renderFrame === undefined) {
    message.renderFrame = requestAnimationFrame(() => {
      message.renderFrame = undefined;
      renderAssistantMarkdown(message.bubble, message.text);
      afterContentChange();
    });
  }
}

function toolLabel(name) {
  if (["read_file", "read", "view_image"].includes(name)) return name === "view_image" ? "查看图片" : "读取文件";
  if (["list_files", "search_files", "find", "glob"].includes(name)) return "查找文件";
  if (["apply_patch", "write_file", "edit_file", "edit", "write"].includes(name)) return "修改文件";
  if (["exec_command", "run_command", "bash", "write_stdin"].includes(name)) return "执行命令";
  if (name === "update_plan") return "更新计划";
  if (name.includes("web") || name.includes("search")) return "搜索资料";
  return "执行操作";
}

function ensureWorkProcess(turn, timestamp = Date.now()) {
  if (turn.process) return turn.process;
  ensureTimeSeparator(timestamp);
  const details = document.createElement("details");
  details.className = "work-process";
  const summary = document.createElement("summary");
  const summaryText = document.createElement("span");
  summary.appendChild(summaryText);
  const groups = document.createElement("ul");
  groups.className = "work-steps";
  details.append(summary, groups);
  messagesElement.appendChild(details);
  turn.process = {
    details,
    summaryText,
    groupsElement: groups,
    groups: new Map(),
    steps: new Map(),
    running: true,
  };
  updateWorkProcess(turn.process);
  afterContentChange();
  return turn.process;
}

function toolResultText(result) {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(toolResultText).filter(Boolean).join("\n");
  if (!result || typeof result !== "object") return "";
  if (typeof result.text === "string") return result.text;
  return "content" in result ? toolResultText(result.content) : "";
}

function isAuthorizationDenied(result) {
  const text = toolResultText(result).toLowerCase();
  return text.includes("user denied") || (text.includes("denied") && text.includes("by user"));
}

function toolResultOutcome(result, isError) {
  if (isAuthorizationDenied(result)) return "denied";
  return isError ? "failed" : "completed";
}

function updateWorkProcess(process) {
  const count = process.steps.size;
  if (process.running) {
    process.summaryText.textContent = `正在处理 · ${count} 项操作`;
    return;
  }
  if (process.status === "unsynced") {
    process.summaryText.textContent = `状态未同步 · ${count} 项操作`;
    return;
  }
  if (process.status === "aborted") {
    process.summaryText.textContent = `已停止 · ${count} 项操作`;
    return;
  }
  if (process.status === "denied") {
    process.summaryText.textContent = `未获授权 · ${count} 项操作`;
    return;
  }
  if (process.status === "failed") {
    process.summaryText.textContent = `未能完成 · ${count} 项操作`;
    return;
  }
  if (process.status === "unknown") {
    process.summaryText.textContent = `工作过程 · ${count} 项操作`;
    return;
  }
  process.summaryText.textContent = `已完成 ${count} 项操作`;
}

function updateWorkGroup(process, group) {
  const count = group.steps.size;
  group.element.textContent = count === 1 ? group.label : `${group.label} ×${count}`;
  const outcomes = [...group.steps].map((step) => step.outcome);
  const denied = outcomes.includes("denied");
  const failed = outcomes.includes("failed");
  group.element.classList.toggle("is-denied", denied);
  group.element.classList.toggle(
    "is-error",
    !denied && failed && (process.running || process.status === "failed"),
  );
}

function updateWorkGroups(process) {
  for (const group of process.groups.values()) updateWorkGroup(process, group);
}

function recordTool(
  turn,
  toolCallId,
  name,
  phase,
  isError = false,
  timestamp = Date.now(),
  outcome,
) {
  const process = ensureWorkProcess(turn, timestamp);
  let step = process.steps.get(toolCallId);
  if (!step) {
    const label = toolLabel(name);
    let group = process.groups.get(label);
    if (!group) {
      const element = document.createElement("li");
      element.className = "work-step";
      group = { label, element, steps: new Set() };
      process.groups.set(label, group);
      process.groupsElement.appendChild(element);
    }
    step = { group, completed: false };
    group.steps.add(step);
    process.steps.set(toolCallId, step);
  }
  if (phase === "completed") {
    step.completed = true;
    step.outcome = outcome ?? toolResultOutcome(undefined, isError);
  }
  updateWorkGroup(process, step.group);
  updateWorkProcess(process);
  afterContentChange();
}

function finishWorkProcess(turn, status) {
  if (!turn?.process) return;
  turn.process.running = false;
  const outcomes = [...turn.process.steps.values()].map((step) => step.outcome);
  turn.process.status = status !== "aborted" && outcomes.includes("denied")
    ? "denied"
    : status;
  updateWorkGroups(turn.process);
  updateWorkProcess(turn.process);
}

function finishHistoricalWorkProcess(turn) {
  if (!turn?.process) return;
  const finalText = turn.assistantBubble?.text;
  finishWorkProcess(
    turn,
    typeof finalText === "string" && finalText.trim() !== "" ? "completed" : "unknown",
  );
}

function newTurnContext(rawMessage = null) {
  return {
    id: null,
    rawMessage,
    assistantBubble: null,
    typingRow: null,
    firstDeltaSeen: false,
    process: null,
    pendingSubmission: false,
  };
}

function ensureLiveTurn(turnId, rawMessage = null) {
  if (
    state.liveTurn?.pendingSubmission
    && state.currentTurnClientId !== state.clientId
  ) {
    removeTyping(state.liveTurn);
    state.liveTurn = null;
  }
  if (state.liveTurn && (state.liveTurn.id === turnId || state.liveTurn.id === null)) {
    state.liveTurn.id = turnId;
    state.liveTurn.pendingSubmission = false;
    return state.liveTurn;
  }
  const historyTurn = state.historyLastTurn;
  if (historyTurn?.id === turnId) {
    state.liveTurn = historyTurn;
    state.liveTurn.pendingSubmission = false;
    if (state.liveTurn.process) {
      state.liveTurn.process.running = true;
      updateWorkProcess(state.liveTurn.process);
    }
  } else {
    state.liveTurn = newTurnContext(rawMessage);
    state.liveTurn.id = turnId;
  }
  if (!state.liveTurn.firstDeltaSeen) appendTyping(state.liveTurn);
  return state.liveTurn;
}

function bindPendingHistoryTurn(event) {
  if (!state.historyTurnPendingBinding) return false;
  state.historyTurnPendingBinding = false;
  const historyTurn = state.historyLastTurn;
  if (
    !historyTurn
    || historyTurn.rawMessage === null
    || (event.message !== undefined && historyTurn.rawMessage !== event.message)
  ) return false;

  historyTurn.id = event.turnId;
  state.lastRenderedUserTurnId = event.turnId;
  return true;
}

function renderTurnUserMessage(event) {
  const historyBound = bindPendingHistoryTurn(event);
  if (event.status !== "running" || event.message === undefined) return;
  if (historyBound || state.lastRenderedUserTurnId === event.turnId) return;

  const optimisticTurn = state.liveTurn;
  const matchesOptimisticTurn = optimisticTurn?.rawMessage === event.message
    && (
      optimisticTurn.id === event.turnId
      || (
        optimisticTurn.id === null
        && optimisticTurn.pendingSubmission
        && event.clientId === state.clientId
      )
    );
  if (!matchesOptimisticTurn) appendUserTimelineMessage(event.message);
  state.lastRenderedUserTurnId = event.turnId;
}

function renderStatus() {
  statusElement.classList.toggle("is-disconnected", !state.connected);
  statusElement.classList.toggle("is-busy", state.connected && state.running);
  if (state.booting) {
    statusText.textContent = "正在连接";
    return;
  }
  if (!state.connected) {
    statusText.textContent = "正在重新连接";
    return;
  }
  if (!state.running) {
    statusText.textContent = "在线";
    return;
  }
  if (state.aborting) {
    statusText.textContent = "正在停止";
    return;
  }
  const label = state.workingPhase === "thinking"
    ? "正在思考"
    : state.workingPhase === "compaction"
      ? "整理记忆"
      : "正在处理";
  statusText.textContent = state.workingSeconds === null
    ? label
    : `${label} · ${state.workingSeconds} 秒`;
}

function focusMessageInput() {
  if (state.booting || !state.connected || state.running || state.submitting) return;
  requestAnimationFrame(() => {
    if (state.booting || !state.connected || state.running || state.submitting) return;
    messageInput.focus({ preventScroll: true });
  });
}

function updateComposer() {
  const unavailable = state.booting || !state.connected;
  const running = state.running || state.submitting;
  messageInput.disabled = unavailable || running;
  uploadButton.disabled = unavailable || running || state.uploading;
  actionButton.classList.toggle("is-stop", running);
  actionButton.setAttribute("aria-label", running ? "停止" : "发送");
  actionButton.title = running ? "停止" : "发送";
  actionButton.type = running ? "button" : "submit";
  actionButton.disabled = unavailable
    || (running
      ? state.currentTurnId === null || state.aborting
      : state.uploading
        || (messageInput.value.trim().length === 0 && state.pendingUploads.length === 0));
  for (const control of modalBackdrop.querySelectorAll("button, input, textarea")) {
    control.disabled = !state.connected
      || state.respondingRequestKey !== null
      || control.dataset.requiresSelection === "true";
  }
}

function setConnection(connected, { showBanner = true } = {}) {
  state.connected = connected;
  connectionBanner.hidden = connected || state.booting || !showBanner;
  renderStatus();
  updateComposer();
  if (connected) focusMessageInput();
}

function setRunning(running) {
  state.running = running;
  if (!running) {
    state.currentTurnId = null;
    state.currentTurnClientId = null;
    state.aborting = false;
    state.workingPhase = "working";
    state.workingSeconds = null;
  }
  renderStatus();
  updateComposer();
  if (!running) focusMessageInput();
}

function reconcileCompletedOutput(output) {
  if (typeof output !== "string" || output.length === 0) return;
  const turn = state.liveTurn;
  if (turn?.assistantBubble) {
    const currentText = turn.assistantBubble.text;
    if (currentText === output || !output.startsWith(currentText)) return;
    if (turn.assistantBubble.renderFrame !== undefined) {
      cancelAnimationFrame(turn.assistantBubble.renderFrame);
      turn.assistantBubble.renderFrame = undefined;
    }
    turn.assistantBubble.text = output;
    renderAssistantMarkdown(turn.assistantBubble.bubble, turn.assistantBubble.text);
    state.lastAssistantText = output;
    afterContentChange();
    return;
  }
  if (turn) {
    turn.assistantBubble = appendMessage("assistant", output);
    turn.assistantBubble.text = output;
    turn.firstDeltaSeen = true;
    return;
  }
  if (state.lastAssistantText !== output) appendMessage("assistant", output);
}

function closeModal() {
  modalBackdrop.hidden = true;
  modalTitle.textContent = "";
  modalMessage.textContent = "";
  modalMessage.hidden = true;
  modalControl.replaceChildren();
  modalActions.replaceChildren();
  modalObserver.hidden = true;
  state.currentRequestKey = null;
  state.respondingRequestKey = null;
}

function onTurn(event) {
  if (event.status === "running" || event.status === "aborting") {
    state.currentTurnId = event.turnId;
    if (event.status === "running") {
      state.currentTurnClientId = event.clientId ?? null;
      if (state.submitting && event.clientId === state.clientId) {
        state.observedSubmissionTurnId = event.turnId;
      }
      state.aborting = false;
      state.workingPhase = "working";
    } else {
      state.aborting = true;
    }
    renderTurnUserMessage(event);
    setRunning(true);
    const turn = ensureLiveTurn(event.turnId, event.message ?? null);
    if (!turn.firstDeltaSeen) appendTyping(turn);
    renderStatus();
    return;
  }

  state.historyTurnPendingBinding = false;
  const turn = state.liveTurn;
  removeTyping(turn);
  finishWorkProcess(turn, event.status);
  if (event.status === "completed") reconcileCompletedOutput(event.output);
  if (event.status === "failed") {
    appendSystemNotice(
      isAuthorizationDenied(event.error)
        ? "你未授权这次操作，未做任何修改。"
        : "这次没有处理成功，请重试。",
      isAuthorizationDenied(event.error) ? "warning" : "error",
    );
  }
  if (event.status === "aborted") appendSystemNotice("已停止");
  closeModal();
  state.lastTerminalTurnId = event.turnId;
  state.liveTurn = null;
  setRunning(false);
}

function handleToolEvent(event) {
  if (typeof event.turnId !== "string" || event.turnId !== state.currentTurnId) return;
  const turn = ensureLiveTurn(event.turnId);
  if (!turn) return;
  if (event.phase === "started") {
    turn.assistantBubble = null;
    recordTool(turn, event.toolCallId, event.name, "started");
    moveTypingToBottom(turn);
  } else if (event.phase === "completed") {
    recordTool(
      turn,
      event.toolCallId,
      event.name,
      "completed",
      event.isError,
      Date.now(),
      toolResultOutcome(event.result, event.isError),
    );
    moveTypingToBottom(turn);
  }
}

function modalButton(label, primary, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `modal-button${primary ? " is-primary" : ""}`;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function friendlyOptionLabel(option) {
  const labels = {
    "Execute the plan": "执行计划",
    "Stay in plan mode": "保持计划模式",
    "Refine the plan": "调整计划",
    "Allow once": "仅本次允许",
    "Allow this command for this session": "本会话允许此命令",
    Deny: "拒绝",
    "Trust this project": "信任此工作区",
    "Trust for this session only": "仅本次会话信任",
    "Do not trust this project": "不信任此工作区",
    "Do not trust for this session only": "本次会话不信任",
  };
  if (labels[option]) return labels[option];
  const parentMatch = /^Trust parent folder \((.*)\)$/i.exec(option);
  if (parentMatch) return `信任上级目录（${parentMatch[1]}）`;
  return option
    .replace(/\s+—\s+API key$/i, " · API 密钥")
    .replace(/\s+—\s+ChatGPT plan$/i, " · ChatGPT 方案")
    .replace(/\s+—\s+Claude account or API key$/i, " · Claude 账号或 API 密钥")
    .replace(/\s+—\s+Coding Plan API key$/i, " · Coding Plan API 密钥")
    .replace(/\s+—\s+account or API key$/i, " · 账号或 API 密钥");
}

function friendlyRequest(request) {
  const title = request.title.trim();

  if (request.method === "confirm") {
    if (/^Apply\b/i.test(title)) {
      return { title: "确认修改文件", message: request.message };
    }
    if (/^Run destructive command\?$/i.test(title)) {
      const command = request.message.split("\n\n", 1)[0];
      return {
        title: "确认高风险操作",
        message: `${command}\n\n这条命令可能删除数据或改变系统、进程状态。`,
      };
    }
    if (/^Enable full access\?$/i.test(title)) {
      return {
        title: "确认开启完整权限",
        message: "之后的命令将在主机上使用不受限制的文件系统和网络权限。请只在可信工作区使用。",
      };
    }
    if (/^Undo\s+.+\?$/i.test(title)) {
      const files = request.message.split("\n\n", 1)[0];
      return {
        title: "确认撤销修改",
        message: `将恢复以下文件：\n${files}\n\n检查点之后的修改不会被覆盖，除非使用强制选项。`,
      };
    }
    const toolMatch = /^Allow\s+(.+?)\??$/i.exec(title);
    if (toolMatch) {
      const toolName = toolMatch[1].trim();
      const label = toolLabel(toolName);
      if (toolName === "exec_command" && request.message.trim()) {
        return {
          title: `需要${label}`,
          message: request.message,
          messageStyle: "command",
        };
      }
      return {
        title: `需要${label}`,
        message: `${agentName} 需要你的确认才能继续${label}。`,
      };
    }
    if (title === "Continue?") return { title: "确认继续", message: request.message };
    return { title: request.title, message: request.message };
  }

  if (request.method === "select") {
    const accessMatch = /^(Allow network access\?|Allow unrestricted host access\?)\n([\s\S]*)$/i.exec(title);
    if (accessMatch) {
      const network = /^Allow network/i.test(accessMatch[1]);
      const details = accessMatch[2];
      const currentMatch = /\nCurrent:\s*([\s\S]*)$/i.exec(details);
      const command = currentMatch ? details.slice(0, currentMatch.index) : details;
      const current = currentMatch ? `\n\n当前权限：${currentMatch[1]}` : "";
      return {
        title: network ? "需要授权网络访问" : "需要授权主机访问",
        message: `${command}${current}`,
        messageStyle: "command",
      };
    }
    const trustMatch = /^Trust this DSCode project\?\n([\s\S]*)$/i.exec(title);
    if (trustMatch) {
      return {
        title: "是否信任此工作区？",
        message: trustMatch[1].replace(
          "Trusted projects may load local settings, instructions, skills, hooks, MCP servers, packages, and extensions.",
          "信任后，项目可以加载本地设置、指令、技能、钩子、MCP 服务、包和扩展。",
        ),
      };
    }
    if (title === "Plan ready — what next?") {
      return { title: "计划已准备好，下一步怎么做？" };
    }
    if (title === "Select a model provider") {
      return { title: "选择模型提供商" };
    }
    return { title: request.title };
  }

  if (request.method === "input" && title === "DeepSeek API base URL") {
    return { title: "设置 DeepSeek API 地址" };
  }
  if (request.method === "editor" && title === "How should the plan change?") {
    return { title: "你希望如何调整计划？" };
  }
  return { title: request.title, message: request.message };
}

async function respondToRequest(request, response) {
  const requestKey = state.currentRequestKey;
  if (requestKey === null || state.respondingRequestKey === requestKey) return;
  state.respondingRequestKey = requestKey;
  updateComposer();
  const result = await api(
    `/v1/sessions/${state.sessionId}/ui-requests/${request.id}/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(response),
    },
  );
  if (state.currentRequestKey !== requestKey) return;
  state.respondingRequestKey = null;
  if (result.ok) {
    closeModal();
  } else {
    updateComposer();
    appendSystemNotice("处理过程中出现了问题，请重试。", "error");
  }
}

function showUiRequest(request, turnId) {
  if (turnId !== state.currentTurnId) return;
  const key = `${turnId}:${request.id}`;
  if (state.currentRequestKey === key) return;
  closeModal();
  state.currentRequestKey = key;
  const friendly = friendlyRequest(request);
  modalTitle.textContent = friendly.title;
  const messageStyle = friendly.messageStyle ?? (/^Apply\b/i.test(request.title.trim()) ? "diff" : "");
  modalMessage.classList.toggle("is-diff", messageStyle === "diff");
  modalMessage.classList.toggle("is-command", messageStyle === "command");
  const owner = state.currentTurnClientId === state.clientId;

  if (friendly.message) {
    modalMessage.textContent = friendly.message;
    modalMessage.hidden = false;
  }

  if (!owner) {
    modalObserver.hidden = false;
    modalBackdrop.hidden = false;
    updateComposer();
    return;
  }

  if (request.method === "confirm") {
    modalActions.append(
      modalButton("取消", false, () => void respondToRequest(request, { confirmed: false })),
      modalButton("确认", true, () => void respondToRequest(request, { confirmed: true })),
    );
  } else if (request.method === "select") {
    let selected = null;
    const confirm = modalButton("确认", true, () => {
      if (selected !== null) void respondToRequest(request, { value: selected });
    });
    confirm.dataset.requiresSelection = "true";
    confirm.disabled = true;
    for (const option of request.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "select-option";
      button.textContent = friendlyOptionLabel(option);
      button.addEventListener("click", () => {
        selected = option;
        for (const sibling of modalControl.children) sibling.classList.remove("is-selected");
        button.classList.add("is-selected");
        confirm.dataset.requiresSelection = "false";
        confirm.disabled = false;
      });
      modalControl.appendChild(button);
    }
    modalActions.append(
      modalButton("取消", false, () => void respondToRequest(request, { cancelled: true })),
      confirm,
    );
  } else {
    const field = document.createElement(request.method === "editor" ? "textarea" : "input");
    if (field instanceof HTMLInputElement) field.type = "text";
    field.placeholder = request.placeholder ?? "";
    field.value = request.prefill ?? "";
    modalControl.appendChild(field);
    modalActions.append(
      modalButton("取消", false, () => void respondToRequest(request, { cancelled: true })),
      modalButton("确认", true, () => void respondToRequest(request, { value: field.value })),
    );
    requestAnimationFrame(() => field.focus());
  }
  modalBackdrop.hidden = false;
  updateComposer();
}

function handleUiEvent(event) {
  if (event.method === "notify") {
    const kind = event.level === "error"
      ? "error"
      : event.level === "warning"
        ? "warning"
        : "info";
    appendSystemNotice(event.message, kind);
  } else if (event.method === "working_message") {
    if (event.message === undefined) {
      state.workingSeconds = null;
    } else {
      const match = /Working \((\d+)s\b/.exec(event.message);
      state.workingSeconds = match ? Number(match[1]) : null;
    }
    renderStatus();
  }
}

function addCurrentStreamListener(source, type, listener) {
  source.addEventListener(type, (event) => {
    if (state.stream !== source) return;
    state.lastEventAt = Date.now();
    listener(event);
  });
}

function openStream() {
  state.stream?.close();
  const source = new EventSource(`/v1/sessions/${state.sessionId}/events`);
  state.stream = source;
  state.lastEventAt = Date.now();
  addCurrentStreamListener(source, "open", () => {
    state.reconnectDue = false;
    state.booting = false;
    setConnection(true);
  });
  source.addEventListener("error", () => {
    if (state.stream !== source) return;
    source.close();
    state.stream = null;
    state.reconnectDue = true;
    state.booting = false;
    closeModal();
    setConnection(false, { showBanner: false });
    void reconnect();
  });
  addCurrentStreamListener(source, "ping", () => {});
  addCurrentStreamListener(source, "turn", (event) => onTurn(JSON.parse(event.data)));
  addCurrentStreamListener(source, "assistant_text_delta", (event) => {
    streamAssistantDelta(JSON.parse(event.data));
  });
  addCurrentStreamListener(source, "thinking_start", (event) => {
    if (JSON.parse(event.data).turnId !== state.currentTurnId) return;
    state.workingPhase = "thinking";
    renderStatus();
  });
  addCurrentStreamListener(source, "thinking_end", (event) => {
    if (JSON.parse(event.data).turnId !== state.currentTurnId) return;
    state.workingPhase = "working";
    renderStatus();
  });
  addCurrentStreamListener(source, "compaction_start", (event) => {
    if (JSON.parse(event.data).turnId !== state.currentTurnId) return;
    state.workingPhase = "compaction";
    renderStatus();
  });
  addCurrentStreamListener(source, "compaction_end", (event) => {
    if (JSON.parse(event.data).turnId !== state.currentTurnId) return;
    state.workingPhase = "working";
    renderStatus();
  });
  addCurrentStreamListener(source, "tool", (event) => handleToolEvent(JSON.parse(event.data)));
  addCurrentStreamListener(source, "ui_request", (event) => {
    const data = JSON.parse(event.data);
    showUiRequest(data.request, data.turnId);
  });
  addCurrentStreamListener(source, "extension_error", () => {
    appendSystemNotice("处理过程中出现了问题，请重试。", "error");
  });
  addCurrentStreamListener(source, "ui_event", (event) => {
    handleUiEvent(JSON.parse(event.data).event);
  });
}

function startWatchdog() {
  if (state.watchdog !== null) return;
  state.watchdog = setInterval(() => {
    if (
      state.reconnectDue
      || state.historySyncDue
      || Date.now() - state.lastEventAt > STALE_MS
    ) {
      state.reconnectDue = false;
      setConnection(false, { showBanner: false });
      void reconnect();
    }
  }, WATCHDOG_MS);
}

function reconcileSessionStatus(session) {
  state.sessionId = session.id;
  state.attachedSessionStatus = session.status;
  if (session.status === "idle") state.historyTurnPendingBinding = false;
  if (session.status !== "idle" || !state.running) return;

  removeTyping(state.liveTurn);
  if (state.liveTurn?.process) {
    state.liveTurn.process.running = false;
    state.liveTurn.process.status = "unsynced";
    updateWorkProcess(state.liveTurn.process);
  }
  closeModal();
  setRunning(false);
}

async function activateSession(entry) {
  if (entry.active) {
    reconcileSessionStatus(entry.session);
    return true;
  }
  const resumeSessionId = state.sessionId ?? entry.session?.id;
  const body = {
    workspaceId: entry.workspaceId,
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
  const response = await jsonPost("/v1/sessions", body);
  if (response.ok) {
    reconcileSessionStatus(response.body);
    return true;
  }
  if (response.status === 409) {
    const retry = await api(`/v1/sessions?workspaceId=${state.workspaceId}`);
    const active = retry.ok ? retry.body.sessions[0] : null;
    if (active?.active) {
      reconcileSessionStatus(active.session);
      return true;
    }
  }
  return false;
}

async function attachSession() {
  const listing = await api(`/v1/sessions?workspaceId=${state.workspaceId}`);
  if (!listing.ok) return false;
  const entry = listing.body.sessions[0];
  if (!entry) return false;
  return activateSession(entry);
}

function renderHistoryMessage(message, currentTurn) {
  if (message.role === "user") {
    finishHistoricalWorkProcess(currentTurn);
    const raw = message.content.map((block) => block.text).join("\n");
    appendUserTimelineMessage(raw, message.timestamp);
    return newTurnContext(raw);
  }
  if (message.role === "assistant") {
    const turn = currentTurn ?? newTurnContext();
    for (const block of message.content) {
      if (block.type === "text") {
        turn.assistantBubble = appendMessage("assistant", block.text, message.timestamp);
        turn.assistantBubble.text = block.text;
        turn.firstDeltaSeen = true;
      } else if (block.type === "toolCall") {
        turn.assistantBubble = null;
        recordTool(turn, block.id, block.name, "started", false, message.timestamp);
      }
    }
    return turn;
  }
  if (message.role === "toolResult") {
    const turn = currentTurn ?? newTurnContext();
    recordTool(
      turn,
      message.toolCallId,
      message.toolName,
      "completed",
      message.isError,
      message.timestamp,
      toolResultOutcome(message.content, message.isError),
    );
    return turn;
  }
  if (message.role === "compactionSummary") {
    finishHistoricalWorkProcess(currentTurn);
    appendSystemNotice("较早的对话已整理为记忆", "info", message.timestamp, {
      showTimeSeparator: false,
    });
    return null;
  }
  return currentTurn;
}

async function renderHistory({ preserveScroll = false, preserveBrowserScroll = false } = {}) {
  const previousScrollTop = scroller.scrollTop;
  const previousFollowLatest = state.followLatest;
  const response = await api(`/v1/sessions/${state.sessionId}/messages`);
  if (!response.ok) return false;
  discardLiveTurn();
  state.followLatest = preserveBrowserScroll
    ? false
    : preserveScroll
      ? previousFollowLatest
      : true;
  resetTimeline();
  let currentTurn = null;
  for (const message of response.body.messages) {
    currentTurn = renderHistoryMessage(message, currentTurn);
  }
  finishHistoricalWorkProcess(currentTurn);
  state.historyLastTurn = currentTurn;
  state.historyTurnPendingBinding = currentTurn !== null
    && currentTurn.rawMessage !== null
    && (state.attachedSessionStatus === "running" || state.attachedSessionStatus === "aborting");
  if (response.body.messages.length === 0) {
    appendMessage(
      "assistant",
      `你好，我是 ${agentName}。有什么需要我帮忙的？`,
      Date.now(),
      { forceScroll: !preserveBrowserScroll },
    );
  }
  configureTimelineRetention();
  if (preserveBrowserScroll) {
    requestAnimationFrame(() => {
      state.followLatest = isNearBottom();
      jumpLatestButton.hidden = state.followLatest;
    });
  } else if (preserveScroll) {
    requestAnimationFrame(() => {
      if (previousFollowLatest) {
        scroller.scrollTop = scroller.scrollHeight;
        jumpLatestButton.hidden = true;
      } else {
        scroller.scrollTop = previousScrollTop;
        jumpLatestButton.hidden = false;
      }
    });
  } else {
    afterContentChange(true);
  }
  return true;
}

async function reconnect({ refreshHistory = false } = {}) {
  if (refreshHistory) state.historySyncDue = true;
  if (state.reconnecting) return;
  if (!state.historySyncDue && Date.now() - state.lastReconnectAt < RECONNECT_GAP_MS) {
    state.reconnectDue = true;
    return;
  }
  state.reconnecting = true;
  state.lastReconnectAt = Date.now();
  const shouldRefreshHistory = state.historySyncDue;
  state.historySyncDue = false;
  try {
    state.stream?.close();
    state.stream = null;
    if (document.visibilityState === "hidden") {
      state.historySyncDue ||= shouldRefreshHistory;
      state.reconnectDue = true;
      return;
    }
    if (!(await attachSession())) {
      state.historySyncDue ||= shouldRefreshHistory;
      state.reconnectDue = true;
      setConnection(false);
      return;
    }
    if (document.visibilityState === "hidden") {
      state.historySyncDue ||= shouldRefreshHistory;
      state.reconnectDue = true;
      return;
    }
    if (shouldRefreshHistory && !(await renderHistory({ preserveScroll: true }))) {
      state.historySyncDue = true;
      state.reconnectDue = true;
      setConnection(false);
      return;
    }
    if (document.visibilityState === "hidden") {
      state.reconnectDue = true;
      return;
    }
    openStream();
  } finally {
    state.reconnecting = false;
    if (
      state.historySyncDue
      && !state.reconnectDue
      && document.visibilityState !== "hidden"
    ) {
      state.lastReconnectAt = 0;
      queueMicrotask(() => void reconnect());
    }
  }
}

function resizeInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  messageInput.scrollTop = messageInput.scrollHeight;
}

function renderPendingUploads() {
  pendingAttachmentsElement.replaceChildren();
  state.pendingUploads.forEach((attachment, index) => {
    const card = document.createElement("div");
    card.className = "pending-attachment";
    const icon = document.createElement("span");
    icon.className = "attachment-icon";
    icon.textContent = "📎";
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = attachment.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-attachment";
    remove.setAttribute("aria-label", `移除附件 ${attachment.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.pendingUploads.splice(index, 1);
      renderPendingUploads();
      updateComposer();
    });
    card.append(icon, name, remove);
    pendingAttachmentsElement.appendChild(card);
  });
  if (state.uploadingFiles.length > 0) {
    const card = document.createElement("div");
    card.className = "pending-attachment is-uploading";
    card.setAttribute("role", "status");
    const spinner = document.createElement("span");
    spinner.className = "upload-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "attachment-name";
    label.textContent = state.uploadingFiles.length === 1
      ? `正在上传 ${state.uploadingFiles[0].name}…`
      : `正在上传 ${state.uploadingFiles.length} 个文件…`;
    card.append(spinner, label);
    pendingAttachmentsElement.appendChild(card);
  }
}

function technicalPrompt(text, attachments) {
  const body = text.trim().length > 0 ? text : "请查看我上传的文件";
  if (attachments.length === 0) return body;
  return `[Uploaded files: ${attachments.map((item) => item.path).join(", ")}]\n${body}`;
}

function restoreSubmission(text, attachments) {
  messageInput.value = text;
  state.pendingUploads = attachments;
  renderPendingUploads();
  resizeInput();
}

function markSendFailed(message) {
  message.row.classList.add("is-failed");
  const stateLabel = document.createElement("span");
  stateLabel.className = "message-state";
  stateLabel.textContent = "发送失败";
  message.meta.appendChild(stateLabel);
}

async function recoverMissingSession() {
  state.stream?.close();
  state.stream = null;
  setConnection(false, { showBanner: false });
  if (!(await attachSession())) {
    setConnection(false);
    return false;
  }
  if (!(await renderHistory({ preserveScroll: true }))) {
    setConnection(false);
    return false;
  }
  openStream();
  return true;
}

async function submitMessage() {
  if (state.running || state.submitting || state.uploading || !state.connected) return;
  const text = messageInput.value;
  const attachments = [...state.pendingUploads];
  if (text.trim().length === 0 && attachments.length === 0) return;

  const prompt = technicalPrompt(text, attachments);
  let optimistic = appendMessage("user", prompt, Date.now(), { forceScroll: true });
  messageInput.value = "";
  state.pendingUploads = [];
  renderPendingUploads();
  resizeInput();
  state.submitting = true;
  state.observedSubmissionTurnId = null;
  state.liveTurn = newTurnContext(prompt);
  state.liveTurn.pendingSubmission = true;
  appendTyping(state.liveTurn);
  updateComposer();

  let response = await jsonPost(`/v1/sessions/${state.sessionId}/turns`, {
    message: prompt,
    clientId: state.clientId,
  });
  if (response.status === 404 && response.body?.error === "session_not_found") {
    if (await recoverMissingSession()) {
      optimistic = appendMessage("user", prompt, Date.now(), { forceScroll: true });
      state.liveTurn = newTurnContext(prompt);
      state.liveTurn.pendingSubmission = true;
      appendTyping(state.liveTurn);
      response = await jsonPost(`/v1/sessions/${state.sessionId}/turns`, {
        message: prompt,
        clientId: state.clientId,
      });
    }
  }

  state.submitting = false;
  if (!response.ok) {
    if (state.observedSubmissionTurnId !== null) {
      updateComposer();
      return;
    }
    if (state.liveTurn?.pendingSubmission) {
      removeTyping(state.liveTurn);
      state.liveTurn = null;
    }
    markSendFailed(optimistic);
    restoreSubmission(text, attachments);
    if (response.status === 409) {
      appendSystemNotice(`${agentName} 正在处理其他消息，请稍后重新发送`, "warning");
    }
    updateComposer();
    focusMessageInput();
    return;
  }
  if (state.lastTerminalTurnId === response.body.id) {
    updateComposer();
    return;
  }
  state.currentTurnId = response.body.id;
  state.currentTurnClientId = state.clientId;
  state.lastRenderedUserTurnId = response.body.id;
  if (!state.liveTurn) state.liveTurn = newTurnContext(prompt);
  state.liveTurn.id = response.body.id;
  state.liveTurn.pendingSubmission = false;
  setRunning(true);
}

async function abortTurn() {
  if (!state.running || state.currentTurnId === null || state.aborting) return;
  state.aborting = true;
  renderStatus();
  updateComposer();
  const response = await api(
    `/v1/sessions/${state.sessionId}/turns/${state.currentTurnId}/abort`,
    { method: "POST" },
  );
  if (!response.ok) {
    state.aborting = false;
    appendSystemNotice("暂时无法停止，请重试。", "error");
    renderStatus();
    updateComposer();
  }
}

async function uploadFiles(files) {
  if (files.length === 0 || state.running || state.uploading || !state.connected) return;
  state.uploading = true;
  state.uploadingFiles = [...files];
  renderPendingUploads();
  updateComposer();
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const response = await api(`/v1/workspaces/${state.workspaceId}/files`, {
    method: "POST",
    body: form,
  });
  state.uploading = false;
  state.uploadingFiles = [];
  if (!response.ok) {
    renderPendingUploads();
    appendSystemNotice(
      response.status === 413 ? "文件太大，无法上传。" : "上传失败，请重试。",
      "error",
    );
    updateComposer();
    return;
  }
  state.pendingUploads.push(...response.body.files);
  renderPendingUploads();
  updateComposer();
}

function showFatal() {
  appElement.hidden = true;
  fatalScreen.hidden = false;
}

async function boot() {
  const parts = location.pathname.split("/");
  state.workspaceId = parts[1] === "chat" ? parts[2] : null;
  if (
    !state.workspaceId
    || !(await attachSession())
    || !(await renderHistory({ preserveBrowserScroll: isBackForwardNavigation() }))
  ) {
    showFatal();
    return;
  }
  openStream();
  startWatchdog();
}

// Treat following as sticky user intent. On iOS, content and composer resizing
// can emit scroll events even though the user did not move toward older messages.
scroller.addEventListener("scroll", () => {
  if (scroller.scrollTop <= 1) setHeaderCollapsed(false);
  if (state.scrollingToEarliest) {
    state.followLatest = false;
    jumpLatestButton.hidden = false;
    if (scroller.scrollTop <= 1) state.scrollingToEarliest = false;
    return;
  }
  if (pointerScrollTop !== null && scroller.scrollTop !== pointerScrollTop) {
    state.scrollIntent = scroller.scrollTop < pointerScrollTop ? "older" : "newer";
    pointerScrollTop = scroller.scrollTop;
  }
  if (isNearBottom()) {
    state.followLatest = true;
    state.jumpingToLatest = false;
    state.scrollIntent = null;
    trimTimelineIfNeeded();
  } else if (state.scrollIntent === "older") {
    stopFollowingLatest();
  }
  jumpLatestButton.hidden = state.followLatest;
});

scroller.addEventListener("pointerdown", () => {
  state.jumpingToLatest = false;
  state.scrollingToEarliest = false;
  pointerScrollTop = scroller.scrollTop;
});

scroller.addEventListener("pointerup", () => {
  pointerScrollTop = null;
  if (isNearBottom()) trimTimelineIfNeeded();
});

scroller.addEventListener("pointercancel", () => {
  pointerScrollTop = null;
  if (isNearBottom()) trimTimelineIfNeeded();
});

scroller.addEventListener("wheel", (event) => {
  state.scrollIntent = event.deltaY < 0 ? "older" : "newer";
}, { passive: true });

scroller.addEventListener("touchstart", (event) => {
  headerGestureDistance = 0;
  previousTouchY = event.touches[0]?.clientY ?? null;
}, { passive: true });

scroller.addEventListener("touchmove", (event) => {
  const currentTouchY = event.touches[0]?.clientY ?? null;
  if (
    currentTouchY !== null
    && previousTouchY !== null
    && currentTouchY !== previousTouchY
  ) {
    state.scrollIntent = currentTouchY > previousTouchY ? "older" : "newer";
    updateHeaderFromTouch(previousTouchY - currentTouchY);
  }
  previousTouchY = currentTouchY;
}, { passive: true });

scroller.addEventListener("touchend", () => {
  headerGestureDistance = 0;
  previousTouchY = null;
  if (isNearBottom()) {
    state.scrollIntent = null;
    trimTimelineIfNeeded();
  }
}, { passive: true });

scroller.addEventListener("touchcancel", () => {
  headerGestureDistance = 0;
  previousTouchY = null;
  if (isNearBottom()) {
    state.scrollIntent = null;
    trimTimelineIfNeeded();
  }
}, { passive: true });

jumpLatestButton.addEventListener("click", () => {
  state.followLatest = true;
  state.jumpingToLatest = true;
  state.scrollingToEarliest = false;
  state.scrollIntent = null;
  jumpLatestButton.hidden = true;
  trimTimelineIfNeeded();
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
});

scrollEarliestHotspot.addEventListener("click", scrollToEarliest);

compactHeaderMedia.addEventListener("change", () => {
  headerGestureDistance = 0;
  if (!compactHeaderMedia.matches) setHeaderCollapsed(false);
});

messageInput.addEventListener("input", () => {
  resizeInput();
  updateComposer();
});
messageInput.addEventListener("compositionstart", () => { state.composing = true; });
messageInput.addEventListener("compositionend", () => { state.composing = false; });
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !state.composing && !event.isComposing) {
    event.preventDefault();
    void submitMessage();
  }
});

composerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitMessage();
});

actionButton.addEventListener("click", (event) => {
  if (state.running || state.submitting) {
    event.preventDefault();
    void abortTurn();
  }
});

uploadButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const selected = [...fileInput.files];
  fileInput.value = "";
  void uploadFiles(selected);
});

function pauseConnection() {
  state.stream?.close();
  state.stream = null;
  if (state.watchdog !== null) clearInterval(state.watchdog);
  state.watchdog = null;
  if (followLatestFrame !== null) cancelAnimationFrame(followLatestFrame);
  followLatestFrame = null;
  setConnection(false, { showBanner: false });
  layoutResizeObserver.disconnect();
}

function resumeConnection(refreshHistory) {
  observeChatLayout();
  state.booting = false;
  state.reconnectDue = false;
  state.lastReconnectAt = 0;
  setConnection(false, { showBanner: false });
  startWatchdog();
  void reconnect({ refreshHistory });
}

let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
let pageLifecyclePaused = false;

// Safari can freeze timers and EventSource delivery while the page is backgrounded.
// A running turn or a stale background interval gets one authoritative history sync;
// BFCache navigation remains on the DOM-preserving reconnect path below.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt ??= Date.now();
    return;
  }
  if (hiddenAt === null || pageLifecyclePaused) return;
  const hiddenDuration = Date.now() - hiddenAt;
  hiddenAt = null;
  if (!state.running && hiddenDuration < STALE_MS) return;
  pauseConnection();
  resumeConnection(true);
});

window.addEventListener("pagehide", () => {
  pageLifecyclePaused = true;
  hiddenAt = null;
  pauseConnection();
});
window.addEventListener("beforeunload", pauseConnection);
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  pageLifecyclePaused = false;
  hiddenAt = null;
  resumeConnection(false);
});

resizeInput();
positionJumpButton();
updateComposer();
renderStatus();
const layoutResizeObserver = new ResizeObserver(() => {
  positionJumpButton();
  scheduleFollowLatest();
});
function observeChatLayout() {
  layoutResizeObserver.observe(composerElement);
  layoutResizeObserver.observe(messagesElement);
  layoutResizeObserver.observe(scroller);
}
observeChatLayout();
void boot();
