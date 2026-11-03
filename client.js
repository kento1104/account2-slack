const workspaceForm = document.querySelector("#workspace-form");
const accountForm = document.querySelector("#account-form");
const workspacesBody = document.querySelector("#workspaces-body");
const accountsBody = document.querySelector("#accounts-body");
const fetchBody = document.querySelector("#fetch-body");
const sendBody = document.querySelector("#send-body");
const accountWorkspaceSelect = document.querySelector("#acc-workspace");
const accountAiTypeSelect = document.querySelector("#acc-ai-type");
const accountApiKeyInput = document.querySelector("#acc-api-key");

const fetchStatus = document.querySelector("#fetch-status");
const sendStatus = document.querySelector("#send-status");

const sendWorkspaceSelect = document.querySelector("#send-workspace");
const sendAccountSelect = document.querySelector("#send-account");
const sendCountInput = document.querySelector("#send-count");
const delayInput = document.querySelector("#delay-input");
const btnAddSend = document.querySelector("#btn-add-send");
const searchStatus = document.querySelector("#search-status");
const searchIsReply = document.querySelector("#search-is-reply");
const activeFetches = new Map();

// --- New flag filter elements ---
const searchIsAdmin = document.querySelector("#search-is-admin");
const searchIsRestricted = document.querySelector("#search-is-restricted");
const searchDeleted = document.querySelector("#search-deleted");
const searchIsUltraRestricted = document.querySelector("#search-is-ultra-restricted");

let cachedWorkspaces = [];
let cachedAccounts = [];
let cachedSendJobs = [];

const searchWorkspace = document.querySelector("#search-workspace");
const searchAccount = document.querySelector("#search-account");
const searchSent = document.querySelector("#search-sent");
const searchUserId = document.querySelector("#search-userid");
const searchDisplay = document.querySelector("#search-display");
const searchSentAtFrom = document.querySelector("#search-sent-at-from");
const searchSentAtTo = document.querySelector("#search-sent-at-to");

const usersBody = document.querySelector("#users-body");
const usersMeta = document.querySelector("#users-meta");
const usersPagination = document.querySelector("#users-pagination");

const logContainer = document.querySelector("#log-container");
const clearLogsBtn = document.querySelector("#clear-logs");
let lastLogId = 0;

window.addEventListener("error", (event) => {
  appendLocalLog({ level: "error", message: `Client Error: ${event.message}` });
});
window.addEventListener("unhandledrejection", (event) => {
  appendLocalLog({ level: "error", message: `Promise Rejection: ${event.reason}` });
});

const usersState = {
  workspaceId: null,
  page: 1,
  pageCount: 1,
  total: 0,
  limit: 20,
  sent: "",
  accountId: "",
  userId: "",
  displayName: "",
  sentAtFrom: "",
  sentAtTo: "",
  status: "",
  reply: "",
  // --- New flag filters ---
  isAdmin: "",
  isRestricted: "",
  deleted: "",
  isUltraRestricted: "",
};

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`Invalid response (${response.status}).`); }
  if (!response.ok) throw new Error(result.error || `Error (${response.status}).`);
  return result;
}

// --- Log Handling ---
function appendLocalLog(log) {
  const div = document.createElement("div");
  div.className = `log-entry log-${log.level}`;
  const time = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="log-time">[${time}]</span> <strong>${log.level.toUpperCase()}</strong>: ${log.message}`;
  logContainer.append(div);
  logContainer.scrollTop = logContainer.scrollHeight;
}

async function pollLogs() {
  try {
    const res = await requestJson(`/api/logs?after=${lastLogId}`);
    if (res.logs && res.logs.length) {
      res.logs.forEach(log => {
        const div = document.createElement("div");
        div.className = `log-entry log-${log.level}`;
        const time = new Date(log.time).toLocaleTimeString();
        div.innerHTML = `<span class="log-time">[${time}]</span> <strong>${log.level.toUpperCase()}</strong>: ${log.message}`;
        logContainer.append(div);
        lastLogId = Math.max(lastLogId, log.id);
      });
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  } catch (e) {
    // Ignore polling errors
  }
}

clearLogsBtn.addEventListener("click", () => {
  logContainer.innerHTML = "";
});

setInterval(pollLogs, 1500);

// --- UI Helpers ---
function makeCell(value) {
  const cell = document.createElement("td");
  const s = value == null || value === "" ? "—" : String(value);
  cell.textContent = s;
  if (s.length > 20) cell.title = s;
  return cell;
}

function makeActionsCell(...children) {
  const cell = document.createElement("td");
  cell.className = "actions";
  for (const child of children) {
    if (child) cell.append(child);
  }
  return cell;
}

function formatTimestamp(value) {
  if (value == null || value === "") return "—";
  try {
    const s = String(value);
    let d = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? new Date(s.replace(" ", "T") + "Z") : new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString();
  } catch { return String(value); }
}

// --- Data Loaders ---
async function loadWorkspaces() {
  const { workspaces } = await requestJson("/api/workspaces");
  cachedWorkspaces = workspaces;
  renderWorkspaces();
  refreshWorkspaceSelect();
  renderFetchTable();
  populateSearchWorkspaceSelect();
  populateSearchAccountSelect();
  populateSendSelects();
  await loadUsers();
}

async function loadAccounts() {
  const { accounts } = await requestJson("/api/accounts");
  cachedAccounts = accounts;
  renderAccounts();
  populateSearchAccountSelect();
  populateSendSelects();
}

async function loadSendJobs() {
  const { jobs } = await requestJson("/api/send-jobs");
  cachedSendJobs = jobs;
  renderSendJobs();
}

const messageInput = document.querySelector("#broadcast-message");
const filterScriptInput = document.querySelector("#filter-script");
const aiPromptInput = document.querySelector("#ai-prompt-input");
const aiPromptsList = document.querySelector("#ai-prompts-list");
const addAiPromptButton = document.querySelector("#add-ai-prompt");

async function saveDraftNow() {
  try {
    await requestJson("/api/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageTemplate: messageInput.value,
        filterScript: filterScriptInput.value,
        aiPrompt: aiPromptInput.value,
        aiPrompts: collectAiPrompts(),
      }),
    });
  } catch (error) { console.warn("Draft save failed:", error.message); }
}

function scheduleDraftSave() {
  if (window._draftTimer) clearTimeout(window._draftTimer);
  window._draftTimer = setTimeout(() => { window._draftTimer = null; saveDraftNow(); }, 500);
}

messageInput.addEventListener("input", scheduleDraftSave);
filterScriptInput.addEventListener("input", scheduleDraftSave);
aiPromptInput.addEventListener("input", scheduleDraftSave);

function collectAiPrompts() {
  const result = {};
  let i = 0;
  for (const row of aiPromptsList.querySelectorAll(".ai-prompt-row")) {
    i += 1;
    const txt = row.querySelector("textarea");
    result[String(i)] = txt ? txt.value : "";
  }
  return result;
}

function renumberAiPromptRows() {
  const rows = Array.from(aiPromptsList.querySelectorAll(".ai-prompt-row"));
  rows.forEach((row, i) => {
    const idx = i + 1;
    row.dataset.promptIndex = String(idx);
    const l = row.querySelector("label"), t = row.querySelector("textarea"), r = row.querySelector(".btn-remove");
    if (l) { l.textContent = `AI_prompt${idx}`; l.htmlFor = `ai-prompt-${idx}`; }
    if (t) { t.id = `ai-prompt-${idx}`; t.dataset.promptIndex = String(idx); t.placeholder = `Value for {AI_prompt${idx}}...`; }
    if (r) r.title = `Remove AI_prompt${idx}`;
  });
}

function addAiPromptField(val = "") {
  const row = document.createElement("div");
  row.className = "ai-prompt-row";
  const label = document.createElement("label");
  const textarea = document.createElement("textarea");
  textarea.value = val;
  textarea.addEventListener("input", scheduleDraftSave);
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn-delete btn-small btn-remove";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => { row.remove(); renumberAiPromptRows(); scheduleDraftSave(); });
  row.append(label, textarea, removeBtn);
  aiPromptsList.append(row);
  renumberAiPromptRows();
  textarea.focus();
}

addAiPromptButton.addEventListener("click", () => addAiPromptField());

async function loadDraft() {
  try {
    const d = await requestJson("/api/draft");
    if (d.messageTemplate) messageInput.value = d.messageTemplate;
    if (d.filterScript) filterScriptInput.value = d.filterScript;
    if (typeof d.aiPrompt === "string") aiPromptInput.value = d.aiPrompt;
    if (d.aiPrompts && typeof d.aiPrompts === "object") {
      const keys = Object.keys(d.aiPrompts).filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
      for (const k of keys) addAiPromptField(d.aiPrompts[String(k)]);
    }
  } catch (e) { console.warn(e); }
  if (!aiPromptsList.querySelector(".ai-prompt-row")) addAiPromptField();
}

// --- Renderers ---
function renderWorkspaces() {
  workspacesBody.replaceChildren();
  for (const ws of cachedWorkspaces) {
    const row = document.createElement("tr");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Delete";
    btn.className = "btn-delete";
    btn.addEventListener("click", async () => {
      if (confirm("Delete workspace?")) {
        await requestJson(`/api/workspaces/${ws.id}`, { method: "DELETE" });
        await loadWorkspaces();
        await loadAccounts();
      }
    });
    row.append(
      makeCell(ws.workspace_name),
      makeCell(ws.slack_route),
      makeCell(ws.upstream),
      makeCell(ws.account_count),
      makeActionsCell(btn)
    );
    workspacesBody.append(row);
  }
}

function renderAccounts() {
  accountsBody.replaceChildren();
  for (const acc of cachedAccounts) {
    const row = document.createElement("tr");

    const tdKeys = document.createElement("td");
    tdKeys.className = "api-key-cell";
    const ta = document.createElement("textarea");
    ta.value = acc.api_key || "";
    ta.placeholder = "No keys configured";

    let saveTimer;
    ta.addEventListener("input", () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        await requestJson(`/api/accounts/${acc.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: ta.value })
        }).catch(err => alert("Failed to save keys: " + err.message));
      }, 500);
    });
    tdKeys.append(ta);

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.textContent = "Delete";
    btnDel.className = "btn-delete";
    btnDel.addEventListener("click", async () => {
      if (confirm("Delete account?")) {
        await requestJson(`/api/accounts/${acc.id}`, { method: "DELETE" });
        await loadWorkspaces();
        await loadAccounts();
      }
    });

    row.append(
      makeCell(acc.workspace_name),
      makeCell(acc.account_name),
      makeCell(acc.ai_type),
      tdKeys,
      makeActionsCell(btnDel)
    );
    accountsBody.append(row);
  }
}

function refreshWorkspaceSelect() {
  const prev = accountWorkspaceSelect.value;
  accountWorkspaceSelect.replaceChildren();
  accountWorkspaceSelect.append(new Option("— select —", ""));
  for (const ws of cachedWorkspaces) accountWorkspaceSelect.append(new Option(ws.workspace_name, ws.id));
  if ([...accountWorkspaceSelect.options].some(o => o.value === prev)) accountWorkspaceSelect.value = prev;
}

function renderFetchTable() {
  fetchBody.replaceChildren();
  for (const ws of cachedWorkspaces) {
    const row = document.createElement("tr");
    let txt = `${ws.total_count ?? "—"} / ${ws.fetched_count}`;
    if (ws.done) txt += " (Complete)";
    const btn = document.createElement("button");
    const isF = activeFetches.has(ws.id);
    btn.type = "button";
    btn.textContent = isF ? "Stop" : "Get";
    btn.disabled = !isF && ws.done;
    btn.addEventListener("click", () => {
      if (activeFetches.has(ws.id)) { activeFetches.get(ws.id).abort(); return; }
      getNextPage(ws.id, btn);
    });
    row.append(
      makeCell(ws.workspace_name),
      makeCell(txt),
      makeActionsCell(btn)
    );
    fetchBody.append(row);
  }
}

async function getNextPage(workspaceId, button) {
  const ctrl = new AbortController();
  activeFetches.set(workspaceId, ctrl);
  button.textContent = "Stop";
  try {
    while (!ctrl.signal.aborted) {
      fetchStatus.textContent = "Fetching...";
      const res = await requestJson(`/api/workspaces/${workspaceId}/fetch`, { method: "POST", signal: ctrl.signal });
      fetchStatus.textContent = `Page ${res.page}/${res.pageCount}. Received ${res.received}.`;
      if (res.done) break;
      await loadWorkspaces();
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) {
    fetchStatus.textContent = e.name === "AbortError" ? "Stopped." : `Error: ${e.message}`;
  } finally {
    activeFetches.delete(workspaceId);
    await loadWorkspaces();
  }
}

function populateSendSelects() {
  const prevWs = sendWorkspaceSelect.value;
  sendWorkspaceSelect.replaceChildren(new Option("— select —", ""));
  for (const ws of cachedWorkspaces) sendWorkspaceSelect.append(new Option(ws.workspace_name, ws.id));
  if ([...sendWorkspaceSelect.options].some(o => o.value === prevWs)) sendWorkspaceSelect.value = prevWs;
  updateSendAccounts();
}

function updateSendAccounts() {
  const wsId = Number(sendWorkspaceSelect.value);
  const prevAcc = sendAccountSelect.value;
  sendAccountSelect.replaceChildren(new Option("— select —", ""));
  if (wsId) {
    for (const a of cachedAccounts.filter(x => x.workspace_id === wsId)) {
      sendAccountSelect.append(new Option(a.account_name, a.id));
    }
  }
  if ([...sendAccountSelect.options].some(o => o.value === prevAcc)) sendAccountSelect.value = prevAcc;
}

sendWorkspaceSelect.addEventListener("change", updateSendAccounts);

btnAddSend.addEventListener("click", async () => {
  const wsId = Number(sendWorkspaceSelect.value);
  const accId = Number(sendAccountSelect.value);
  const count = Number(sendCountInput.value);
  if (!wsId || !accId || count <= 0) return alert("Select workspace, account, and a valid count.");

  await requestJson("/api/send-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_id: wsId, account_id: accId, count })
  });
  await loadSendJobs();
});

let globalPollId = null;

function ensurePolling() {
  if (globalPollId) return;
  globalPollId = setInterval(async () => {
    const hasRunning = cachedSendJobs.some(j => j.status === "running");
    if (hasRunning) {
      await loadUsers();
      const res = await requestJson("/api/send-jobs");
      cachedSendJobs = res.jobs;
      renderSendJobs();
    }
  }, 2000);
}

function renderSendJobs() {
  sendBody.replaceChildren();
  let hasRunning = false;

  for (const job of cachedSendJobs) {
    if (job.status === "running") hasRunning = true;

    const row = document.createElement("tr");

    const tdCount = document.createElement("td");
    const countInput = document.createElement("input");
    countInput.type = "number";
    countInput.min = "1";
    countInput.className = "recipient-input";
    countInput.value = job.count;
    countInput.disabled = job.status === "running";

    let saveTimer;
    countInput.addEventListener("input", () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const newCount = Number(countInput.value);
        if (newCount > 0 && newCount !== job.count) {
          await requestJson(`/api/send-jobs/${job.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ count: newCount })
          }).catch(err => alert("Save failed: " + err.message));
          job.count = newCount;
        }
      }, 500);
    });
    tdCount.append(countInput);

    const btnToggle = document.createElement("button");
    btnToggle.type = "button";

    let toggleAction = "/start";
    if (job.status === "running") {
      btnToggle.textContent = "Stop";
      btnToggle.className = "btn-delete";
      toggleAction = "/stop";
    } else if (job.status === "paused") {
      btnToggle.textContent = "Resume";
      btnToggle.className = "";
      toggleAction = "/start";
    } else {
      btnToggle.textContent = "Send";
      btnToggle.className = "";
      toggleAction = "/start";
    }

    btnToggle.addEventListener("click", async () => {
      btnToggle.disabled = true;
      sendStatus.textContent = toggleAction === "/start" ? "Starting messages..." : "Stopping...";
      try {
        await requestJson(`/api/send-jobs/${job.id}${toggleAction}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: toggleAction === "/start" ? JSON.stringify({
             messageTemplate: messageInput.value,
             aiPrompt: aiPromptInput.value,
             aiPrompts: collectAiPrompts(),
             filterScript: filterScriptInput.value,
             delayMs: Number(delayInput.value) || 1000
          }) : undefined
        });
        await loadSendJobs();
        ensurePolling();
      } catch (e) {
        sendStatus.textContent = "Error: " + e.message;
        btnToggle.disabled = false;
      }
    });

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.className = "btn-delete";
    del.disabled = job.status === "running";
    del.addEventListener("click", async () => {
      await requestJson(`/api/send-jobs/${job.id}`, { method: "DELETE" });
      await loadSendJobs();
    });

    let statusText = job.status || "pending";
    let statusCls = "";
    if (statusText === "running") { statusText = `${job.count} / ${job.sent_count || 0}`; statusCls = "status-running"; }
    else if (statusText === "completed") statusCls = "status-completed";
    else if (statusText === "failed") statusCls = "status-failed";
    else if (statusText === "paused") statusCls = "status-paused";
    else if (statusText === "cancelled") statusCls = "status-cancelled";

    const totalText = `${job.total} / ${job.workspace_sent || 0}`;

    row.append(
      makeCell(job.workspace_name),
      makeCell(totalText),
      makeCell(job.account_name),
      tdCount,
      makeCell(statusText),
      makeActionsCell(btnToggle, del)
    );
    row.children[4].className = statusCls;
    sendBody.append(row);
  }

  if (hasRunning) ensurePolling();
}

function makeDisplayNameCell(u) {
  const cell = document.createElement("td");
  if (!u.display_name) { cell.textContent = "—"; return cell; }
  const span = document.createElement("span");
  span.className = "display-name-link";
  span.textContent = u.display_name;
  span.addEventListener("click", (ev) => {
    ev.stopPropagation();
    let obj = {};
    try { obj = JSON.parse(u.user_json); } catch { obj = { id: u.user_id, display_name: u.display_name }; }
    openUserPopup(obj, u.display_name, ev);
  });
  cell.append(span);
  return cell;
}

function makeTruncatedCell(txt, cellCls, spanCls) {
  const td = document.createElement("td");
  td.className = cellCls;
  if (!txt) {
    td.innerHTML = '<span class="ai-prompt-empty">—</span>';
    return td;
  }

  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.alignItems = "center";
  wrapper.style.gap = "4px";
  wrapper.style.minWidth = "0";

  const span = document.createElement("span");
  span.className = spanCls;
  span.textContent = txt;
  span.title = txt;
  span.style.whiteSpace = "nowrap";
  span.style.overflow = "hidden";
  span.style.textOverflow = "ellipsis";
  span.style.flex = "1";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.innerHTML = "📋";
  copyBtn.title = "Copy to clipboard";
  copyBtn.style.padding = "0 4px";
  copyBtn.style.height = "20px";
  copyBtn.style.fontSize = "12px";
  copyBtn.style.background = "transparent";
  copyBtn.style.border = "none";
  copyBtn.style.cursor = "pointer";
  copyBtn.style.opacity = "0.5";
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(txt).then(() => {
      copyBtn.innerHTML = "✔️";
      setTimeout(() => { copyBtn.innerHTML = "📋"; }, 1500);
    }).catch(err => {
      alert("Failed to copy: " + err.message);
    });
  });
  copyBtn.addEventListener("mouseenter", () => { copyBtn.style.opacity = "1"; });
  copyBtn.addEventListener("mouseleave", () => { copyBtn.style.opacity = "0.5"; });

  wrapper.append(span, copyBtn);
  td.append(wrapper);
  return td;
}

function makeAiPromptCell(txt) { return makeTruncatedCell(txt, "ai-prompt-cell", "ai-prompt-text"); }
function makeMessageCell(txt) { return makeTruncatedCell(txt, "message-cell", "message-text"); }
function makeAiResponseCell(txt) { return makeTruncatedCell(txt, "ai-response-cell", "ai-response-text"); }

// --- Pagination ---
function buildPageItems(current, total, windowSize = 2) {
  if (total <= 0) return [];
  if (total === 1) return [1];

  const items = new Set();
  items.add(1);
  items.add(total);
  for (let i = current - windowSize; i <= current + windowSize; i++) {
    if (i >= 1 && i <= total) items.add(i);
  }
  for (let i = 1; i <= Math.min(3, total); i++) items.add(i);
  for (let i = Math.max(1, total - 2); i <= total; i++) items.add(i);

  const sorted = [...items].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const n of sorted) {
    if (prev && n - prev > 1) out.push("ellipsis");
    out.push(n);
    prev = n;
  }
  return out;
}

function renderPagination() {
  usersPagination.replaceChildren();
  const { page, pageCount } = usersState;
  if (!pageCount || pageCount < 1) return;

  const makeBtn = (label, targetPage, opts = {}) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = opts.className || "";
    b.textContent = label;
    if (opts.disabled) b.disabled = true;
    if (opts.active) { b.classList.add("is-active"); b.disabled = true; }
    if (opts.title) b.title = opts.title;
    if (!b.disabled && targetPage != null) {
      b.addEventListener("click", () => goToPage(targetPage));
    }
    return b;
  };

  usersPagination.append(makeBtn("« First", 1, { disabled: page <= 1, title: "Go to first page" }));
  usersPagination.append(makeBtn("‹ Prev", page - 1, { disabled: page <= 1, title: "Go to previous page" }));

  const items = buildPageItems(page, pageCount, 2);
  for (const it of items) {
    if (it === "ellipsis") {
      const span = document.createElement("span");
      span.className = "ellipsis";
      span.textContent = "…";
      usersPagination.append(span);
    } else {
      usersPagination.append(makeBtn(String(it), it, {
        className: "page-btn",
        active: it === page,
        title: `Go to page ${it}`,
      }));
    }
  }

  usersPagination.append(makeBtn("Next ›", page + 1, { disabled: page >= pageCount, title: "Go to next page" }));
  usersPagination.append(makeBtn("Last »", pageCount, { disabled: page >= pageCount, title: "Go to last page" }));

  const info = document.createElement("span");
  info.className = "page-info";
  info.textContent = `Page ${page} / ${pageCount} (${usersState.total} users)`;
  usersPagination.append(info);

  const jump = document.createElement("span");
  jump.className = "page-jump";
  const inp = document.createElement("input");
  inp.type = "number";
  inp.min = "1";
  inp.max = String(pageCount);
  inp.placeholder = "Page";
  inp.value = "";
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const n = Number(inp.value);
      if (Number.isFinite(n) && n >= 1 && n <= pageCount && n !== page) goToPage(n);
      inp.value = "";
    }
  });
  const goBtn = document.createElement("button");
  goBtn.type = "button";
  goBtn.textContent = "Go";
  goBtn.addEventListener("click", () => {
    const n = Number(inp.value);
    if (Number.isFinite(n) && n >= 1 && n <= pageCount && n !== page) goToPage(n);
    inp.value = "";
  });
  jump.append(inp, goBtn);
  usersPagination.append(jump);
}

function goToPage(p) {
  const target = Math.max(1, Math.min(usersState.pageCount || 1, p));
  if (target === usersState.page) return;
  usersState.page = target;
  loadUsers();
}
function makeFlagCell(v) {
  const cell = document.createElement("td");
  if (v === null || v === undefined) { cell.textContent = "—"; return cell; }
  cell.textContent = v ? "Yes" : "No";
  cell.className = v ? "status-yes" : "status-no";
  return cell;
}
async function loadUsers() {
  try {
    const qs = new URLSearchParams({
      page: String(usersState.page),
      limit: String(usersState.limit),
    });
    if (usersState.workspaceId) qs.set("workspace_id", usersState.workspaceId);
    if (usersState.sent) qs.set("sent", usersState.sent);
    if (usersState.accountId) qs.set("account_id", usersState.accountId);
    if (usersState.userId) qs.set("user_id", usersState.userId);
    if (usersState.displayName) qs.set("display_name", usersState.displayName);
    if (usersState.sentAtFrom) qs.set("sent_at_from", usersState.sentAtFrom);
    if (usersState.sentAtTo) qs.set("sent_at_to", usersState.sentAtTo);

    if (usersState.status) qs.set("status", usersState.status);
    if (usersState.reply) qs.set("reply", usersState.reply);

    // --- New flag filters ---
    if (usersState.isAdmin) qs.set("is_admin", usersState.isAdmin);
    if (usersState.isRestricted) qs.set("is_restricted", usersState.isRestricted);
    if (usersState.deleted) qs.set("deleted", usersState.deleted);
    if (usersState.isUltraRestricted) qs.set("is_ultra_restricted", usersState.isUltraRestricted);

    const { users, page, pageCount, total } = await requestJson(`/api/users?${qs}`);
    usersState.page = page;
    usersState.pageCount = pageCount;
    usersState.total = total;

    usersBody.replaceChildren();
    const start = (page - 1) * usersState.limit;

    users.forEach((u, i) => {
      const row = document.createElement("tr");
      row.append(makeCell(start + i + 1));
      row.append(makeCell(u.workspace_name));
      row.append(makeCell(u.user_id));
      row.append(makeDisplayNameCell(u));

      const dm = document.createElement("td");
      if (u.dm_url) {
        dm.innerHTML = `<a href="${u.dm_url}" target="_blank" rel="noopener noreferrer">Open DM</a>`;
      } else {
        dm.textContent = "—";
      }
      row.append(dm);

            const sc = document.createElement("td");
      if (u.skipped) {
        sc.textContent = "Skip";
        sc.className = "status-skip";
      } else {
        sc.textContent = u.is_sent ? "Yes" : "No";
        sc.className = u.is_sent ? "status-yes" : "status-no";
      }
      row.append(sc);

      row.append(makeCell(formatTimestamp(u.sent_at)));
      row.append(makeCell(u.account_name));

      row.append(makeCell(u.score));
      row.append(makeCell(u.threshold));

      row.append(makeFlagCell(u.is_admin));
      row.append(makeFlagCell(u.is_restricted));
      row.append(makeFlagCell(u.deleted));
      row.append(makeFlagCell(u.is_ultra_restricted));

      row.append(makeAiPromptCell(u.ai_prompt));   // only once
      row.append(makeMessageCell(u.message));
      row.append(makeAiResponseCell(u.ai_response));

      const statusCell = document.createElement("td");
      const statusText = u.status || "alive";
      statusCell.textContent = statusText;
      if (statusText === "dead") statusCell.className = "status-dead";
      row.append(statusCell);

      row.append(makeCell(u.reply || "no"));

      usersBody.append(row);
    });

    usersMeta.textContent = `${total} users total`;
    renderPagination();
  } catch (e) {
    sendStatus.textContent = "Load error: " + e.message;
  }
}

function applySearch() {
  usersState.sent = searchSent.value;
  usersState.accountId = searchAccount.value;
  usersState.userId = searchUserId.value.trim();
  usersState.displayName = searchDisplay.value.trim();
  usersState.sentAtFrom = searchSentAtFrom.value;
  usersState.sentAtTo = searchSentAtTo.value;
  usersState.status = searchStatus.value;
  usersState.reply = searchIsReply.value;

  // --- New flag filters ---
  usersState.isAdmin = searchIsAdmin.value;
  usersState.isRestricted = searchIsRestricted.value;
  usersState.deleted = searchDeleted.value;
  usersState.isUltraRestricted = searchIsUltraRestricted.value;

  usersState.page = 1;
  loadUsers();
}

function populateSearchWorkspaceSelect() {
  const prev = usersState.workspaceId || "";
  searchWorkspace.replaceChildren(new Option("All", ""));
  for (const ws of cachedWorkspaces) searchWorkspace.append(new Option(ws.workspace_name, ws.id));
  searchWorkspace.value = prev;
}

function populateSearchAccountSelect() {
  const prev = searchAccount.value;
  const wsId = usersState.workspaceId;
  searchAccount.replaceChildren(new Option("All", ""));
  const accs = wsId ? cachedAccounts.filter(a => a.workspace_id === wsId) : cachedAccounts;
  for (const a of accs) searchAccount.append(new Option(a.account_name, a.id));
  if ([...searchAccount.options].some(o => o.value === prev)) searchAccount.value = prev;
}

searchWorkspace.addEventListener("change", () => {
  usersState.workspaceId = Number(searchWorkspace.value) || null;
  populateSearchAccountSelect();
  applySearch();
});
searchAccount.addEventListener("change", applySearch);
searchSent.addEventListener("change", applySearch);
searchUserId.addEventListener("input", debounce(applySearch, 300));
searchDisplay.addEventListener("input", debounce(applySearch, 300));
searchSentAtFrom.addEventListener("change", applySearch);
searchSentAtTo.addEventListener("change", applySearch);
searchStatus.addEventListener("change", applySearch);
searchIsReply.addEventListener("change", applySearch);

// --- New flag filter listeners ---
searchIsAdmin.addEventListener("change", applySearch);
searchIsRestricted.addEventListener("change", applySearch);
searchDeleted.addEventListener("change", applySearch);
searchIsUltraRestricted.addEventListener("change", applySearch);

function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

const refreshUsersBtn = document.querySelector("#refresh-users");
if (refreshUsersBtn) {
  refreshUsersBtn.addEventListener("click", loadUsers);
}

let userPopupEl = null;
function closeUserPopup() { if (userPopupEl) { userPopupEl.remove(); userPopupEl = null; } }
document.addEventListener("mousedown", (e) => { if (userPopupEl && !userPopupEl.contains(e.target)) closeUserPopup(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeUserPopup(); });

function openUserPopup(obj, name, ev) {
  closeUserPopup();
  const pop = document.createElement("div");
  pop.className = "user-popup";
  pop.style.left = "0px"; pop.style.top = "0px";

  const head = document.createElement("div");
  head.className = "user-popup-header";
  const t = document.createElement("span"); t.className = "title"; t.textContent = name || "User Info";
  const x = document.createElement("button"); x.className = "user-popup-close"; x.textContent = "×";
  x.onclick = closeUserPopup;
  head.append(t, x);
  pop.append(head);

  const body = document.createElement("div");
  body.className = "user-popup-body";

  const addGrp = (title, entries) => {
    if (!entries.length) return;
    const g = document.createElement("div"); g.className = "kv-group";
    const h = document.createElement("div"); h.className = "kv-group-title"; h.textContent = title;
    g.append(h);
    for (const [k, v] of entries) {
      const r = document.createElement("div"); r.className = "kv-row";
      const kd = document.createElement("div"); kd.className = "kv-key"; kd.textContent = k;
      const vd = document.createElement("div"); vd.className = "kv-val";
      if (v === null || v === undefined) { vd.textContent = "null"; vd.classList.add("is-empty"); }
            else if (typeof v === "object") { vd.textContent = JSON.stringify(v, null, 2); }
      else { vd.textContent = String(v); if (!v) vd.classList.add("is-empty"); }
      r.append(kd, vd); g.append(r);
    }
    body.append(g);
  };

  const top = [];
  for (const [k, v] of Object.entries(obj)) { if (k !== "profile") top.push([k, v]); }
  if (obj.profile && typeof obj.profile === "object") {
    addGrp("Profile", Object.entries(obj.profile).map(([k, v]) => [`profile.${k}`, v]));
  }
  addGrp("Top-level", top);
  pop.append(body);

  document.body.append(pop);
  const rect = pop.getBoundingClientRect();
  let l = ev ? ev.clientX : innerWidth / 2;
  let tp = ev ? ev.clientY : innerHeight / 2;
  if (l + rect.width > innerWidth) l = innerWidth - rect.width - 8;
  if (tp + rect.height > innerHeight) tp = innerHeight - rect.height - 8;
  pop.style.left = Math.max(8, l) + "px";
  pop.style.top = Math.max(8, tp) + "px";
  userPopupEl = pop;
}

workspaceForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = document.querySelector("#save-workspace");
  b.disabled = true;
  try {
    await requestJson("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upstream: document.querySelector("#ws-upstream").value,
        slack_route: document.querySelector("#ws-slack-route").value,
        workspace_name: document.querySelector("#ws-workspace-name").value,
      }),
    });
    await loadWorkspaces();
  } catch (err) { alert(err.message); }
  finally { b.disabled = false; }
});

accountForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = document.querySelector("#save-account");
  b.disabled = true;
  try {
    await requestJson("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: Number(accountWorkspaceSelect.value),
        account_name: document.querySelector("#acc-account-name").value,
        ai_type: accountAiTypeSelect.value,
        api_key: accountApiKeyInput.value,
        cookie: document.querySelector("#acc-cookie").value,
        token: document.querySelector("#acc-token").value,
      }),
    });
    document.querySelector("#acc-cookie").value = "";
    document.querySelector("#acc-token").value = "";
    accountApiKeyInput.value = "";
    await loadWorkspaces();
    await loadAccounts();
  } catch (err) { alert(err.message); }
  finally { b.disabled = false; }
});

(async () => {
  try {
    await loadDraft();
    await loadWorkspaces();
    await loadAccounts();
    await loadSendJobs();
    ensurePolling();
  } catch (e) { console.error(e); }
})();