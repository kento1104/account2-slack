const http = require("node:http");
const { randomBytes, randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const vm = require("node:vm");

try {
  const envFile = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  envFile.split("\n").forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let value = match[2] || "";
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      process.env[key] = value;
    }
  });
} catch (e) { console.log("No .env file found."); }

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 1024 * 1024;
const INDEX_PATH = path.join(__dirname, "index.html");
const CLIENT_PATH = path.join(__dirname, "client.js");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "slack-people.sqlite");

const AI_TYPES = new Set(["openai", "gemini", "mistral"]);
const MISTRAL_MODEL = "ministral-14b-2512";
const OPENAI_MODEL = "gpt-4o-mini";
const GEMINI_MODEL = "gemini-1.5-flash";

const CHAT_QUERY_PARAMS = [
  ["_x_id", "38fe1ffc-1792738894.899"],
  ["_x_csid", "vwaC2iUZpts"],
  ["slack_route", ""],
  ["_x_version_ts", "1792728450"],
  ["_x_foreground", "true"],
  ["_x_frontend_build_type", "current"],
  ["_x_desktop_ia", "4"],
  ["_x_gantry", "true"],
  ["fp", "0c"],
  ["_x_num_retries", "0"],
];

const CHAT_FORM_FIELDS = [
  ["channel", ""], ["ts", "1792738894.xxxxxx"], ["type", "message"],
  ["xArgs", ""], ["client_context_team_id", ""], ["draft_id", ""],
  ["unfurl", "[]"], ["include_channel_perm_error", "true"],
  ["client_msg_id", ""], ["blocks", ""], ["x_reason", "webapp_message_send"],
  ["x_mode", "online"], ["x_sonic", "true"], ["x_app_name", "client"],
];

// --- Logging System ---
let logBuffer = [];
let logIdCounter = 0;

function log(level, message) {
  logIdCounter++;
  const entry = { id: logIdCounter, time: new Date().toISOString(), level, message };
  logBuffer.push(entry);
  if (logBuffer.length > 2000) logBuffer.shift(); 
  console.log(`[${level.toUpperCase()}] ${message}`);
}

process.on("uncaughtException", (err) => log("error", `Uncaught Exception: ${err.stack || err.message}`));
process.on("unhandledRejection", (reason) => log("error", `Unhandled Rejection: ${reason}`));
// -----------------------

function makeBoundary() {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return `----WebKitFormBoundary${Array.from(randomBytes(16)).map(b => a[b % a.length]).join("")}`;
}

function makeMultipartBody(fields, boundary) {
  return Buffer.from(fields.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join("") + `--${boundary}--\r\n`, "utf8");
}

function getHeaders(cookie, boundary) {
  return {
    Accept: "*/*", "Accept-Encoding": "gzip, deflate, br, zstd", "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
    "Content-Type": `multipart/form-data; boundary=${boundary}`, Cookie: cookie,
    Origin: "https://app.slack.com", Priority: "u=1",
    "Sec-CH-UA": '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
    "Sec-CH-UA-Mobile": "?0", "Sec-CH-UA-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-site",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  };
}

function buildUsersListRequest({ upstream, slack_route, cookie, token, cursor }) {
  const url = new URL("/api/users.list", upstream);
  url.searchParams.append("token", token);
  url.searchParams.append("slack_route", slack_route);
  url.searchParams.append("limit", "200");
  if (cursor) url.searchParams.append("cursor", cursor);
  
  const boundary = makeBoundary();
  const fields = [["token", token]];
  const body = makeMultipartBody(fields, boundary);
  
  return { url, headers: getHeaders(cookie, boundary), body };
}

function buildChatRequest({ upstream, slack_route, cookie, token, userId, messageText }) {
  const url = new URL("/api/chat.postMessage", upstream);
  for (const [k, v] of CHAT_QUERY_PARAMS) url.searchParams.append(k, k === "slack_route" ? slack_route : v);
  
  const blocks = JSON.stringify([{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: messageText }] }] }]);
  const draftId = randomUUID(), clientMsgId = randomUUID();
  
  const fields = [["token", token], ...CHAT_FORM_FIELDS.map(([k, v]) => {
    if (k === "channel") return [k, userId];
    if (k === "blocks") return [k, blocks];
    if (k === "draft_id") return [k, draftId];
    if (k === "client_msg_id") return [k, clientMsgId];
    if (k === "xArgs") return [k, `{"draft_id":"${draftId}"}`];
    if (k === "client_context_team_id") return [k, slack_route];
    return [k, v];
  })];
  
  const boundary = makeBoundary();
  const body = makeMultipartBody(fields, boundary);
  
  return { url, headers: getHeaders(cookie, boundary), body };
}

function renderTemplate(template, mapping) {
  return String(template).replace(/\{([^{}]+)\}/g, (_, k) => {
    if (!(k in mapping)) return "";
    const v = mapping[k];
    return v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
  });
}

function buildTemplateMapping(userObject, aiAnswer) {
  const mapping = {};
  if (aiAnswer !== undefined) mapping["AI_answer"] = aiAnswer;
  if (userObject && typeof userObject === "object") {
    for (const [k, v] of Object.entries(userObject)) mapping[k] = v;
    walkUserPaths(userObject, "", mapping);
  }
  return mapping;
}

function walkUserPaths(obj, prefix, out) {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") { out[p] = v; walkUserPaths(v, p, out); }
    else out[p] = v;
  }
}

function resolveAiComposer(composer, user, prompts) {
  return String(composer).replace(/\{([^{}]+)\}/g, (m, k) => {
    if (prompts && prompts[k] != null) return String(prompts[k]);
    let cur = user;
    for (const p of k.split(".")) { if (!cur || typeof cur !== "object" || !(p in cur)) return m; cur = cur[p]; }
    return cur == null ? "" : (typeof cur === "object" ? JSON.stringify(cur) : String(cur));
  });
}

function validateWorkspaceInput(input) {
  if (!input || typeof input !== "object") return "Expected JSON.";
  let u;
  try { u = new URL(input.upstream); } catch { return "Invalid URL."; }
  if (u.protocol !== "https:" || !(u.hostname === "slack.com" || u.hostname.endsWith(".slack.com")) || u.username || u.password || u.port || u.pathname !== "/" || u.search || u.hash) return "HTTPS Slack URL required.";
  if (typeof input.slack_route !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.slack_route)) return "Route required.";
  if (typeof input.workspace_name !== "string" || !input.workspace_name.trim()) return "Name required.";
  return null;
}

function validateAccountInput(input) {
  if (!input || typeof input !== "object") return "Expected JSON.";
  if (!Number.isInteger(input.workspace_id) || input.workspace_id <= 0) return "Workspace required.";
  if (typeof input.account_name !== "string" || !input.account_name.trim()) return "Name required.";
  if (typeof input.ai_type !== "string" || !AI_TYPES.has(input.ai_type)) return "Invalid AI type.";
  if (typeof input.api_key !== "string" || !input.api_key.trim()) return "API key required.";
  if (typeof input.cookie !== "string" || !input.cookie || /[\r\n]/.test(input.cookie)) return "Cookie required.";
  if (typeof input.token !== "string" || !input.token || /[\r\n]/.test(input.token)) return "Token required.";
  return null;
}

function initializeDatabase(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY, upstream TEXT NOT NULL, slack_route TEXT NOT NULL, workspace_name TEXT NOT NULL,
      next_page INTEGER NOT NULL DEFAULT 1, page_count INTEGER, total_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      account_name TEXT NOT NULL, api_key TEXT NOT NULL, cookie TEXT NOT NULL, token TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS userlist (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, user_json TEXT NOT NULL, fetched_page INTEGER NOT NULL, UNIQUE(workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS sent_users (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS draft (
      id INTEGER PRIMARY KEY CHECK (id = 1), message_template TEXT NOT NULL DEFAULT '',
      filter_script TEXT NOT NULL DEFAULT '', ai_prompt TEXT NOT NULL DEFAULT '', ai_prompts TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS send_jobs (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
      count INTEGER NOT NULL, sent_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS send_logs (
      id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
      count INTEGER NOT NULL, status TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS key_cooldowns (
      api_key TEXT PRIMARY KEY, cooldown_until DATETIME NOT NULL
    );
  `);

  try {
    const c = db.prepare("PRAGMA table_info(sent_users)").all().map(x => x.name);
    if (!c.includes("account_id")) db.exec("ALTER TABLE sent_users ADD COLUMN account_id INTEGER");
    if (!c.includes("score")) db.exec("ALTER TABLE sent_users ADD COLUMN score REAL");
    if (!c.includes("threshold")) db.exec("ALTER TABLE sent_users ADD COLUMN threshold REAL");
    if (!c.includes("ai_prompt")) db.exec("ALTER TABLE sent_users ADD COLUMN ai_prompt TEXT");
    if (!c.includes("message")) db.exec("ALTER TABLE sent_users ADD COLUMN message TEXT");
    if (!c.includes("ai_response")) db.exec("ALTER TABLE sent_users ADD COLUMN ai_response TEXT");
    
    if (!c.includes("dm_url")) db.exec("ALTER TABLE sent_users ADD COLUMN dm_url TEXT");
    if (!c.includes("status")) db.exec("ALTER TABLE sent_users ADD COLUMN status TEXT DEFAULT 'alive'");
    if (!c.includes("reply")) db.exec("ALTER TABLE sent_users ADD COLUMN reply TEXT DEFAULT 'no'");
    if (!c.includes("skipped")) {
  db.exec("ALTER TABLE sent_users ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE sent_users SET skipped = 1 WHERE message = 'SKIPPED'");
  db.exec("UPDATE sent_users SET message = NULL WHERE message = 'SKIPPED'");
}
    const jc = db.prepare("PRAGMA table_info(send_jobs)").all().map(x => x.name);
    if (!jc.includes("sent_count")) db.exec("ALTER TABLE send_jobs ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0");

    const wc = db.prepare("PRAGMA table_info(workspaces)").all().map(x => x.name);
    if (!wc.includes("cursor")) db.exec("ALTER TABLE workspaces ADD COLUMN cursor TEXT");

    const d = db.prepare("PRAGMA table_info(draft)").all().map(x => x.name);
    if (!d.length) db.exec(`CREATE TABLE draft (id INTEGER PRIMARY KEY CHECK (id=1), message_template TEXT NOT NULL DEFAULT '', filter_script TEXT NOT NULL DEFAULT '', ai_prompt TEXT NOT NULL DEFAULT '', ai_prompts TEXT NOT NULL DEFAULT '{}')`);
    else {
      if (!d.includes("ai_prompt")) db.exec("ALTER TABLE draft ADD COLUMN ai_prompt TEXT NOT NULL DEFAULT ''");
      if (!d.includes("ai_prompts")) db.exec("ALTER TABLE draft ADD COLUMN ai_prompts TEXT NOT NULL DEFAULT '{}'");
    }
    if (!db.prepare("SELECT id FROM draft WHERE id=1").get()) db.prepare("INSERT INTO draft (id) VALUES (1)").run();

    // --- userlist flag columns (is_admin, is_restricted, deleted, is_ultra_restricted) ---
    const uc = db.prepare("PRAGMA table_info(userlist)").all().map(x => x.name);
    if (!uc.includes("is_admin")) db.exec("ALTER TABLE userlist ADD COLUMN is_admin INTEGER");
    if (!uc.includes("is_restricted")) db.exec("ALTER TABLE userlist ADD COLUMN is_restricted INTEGER");
    if (!uc.includes("deleted")) db.exec("ALTER TABLE userlist ADD COLUMN deleted INTEGER");
    if (!uc.includes("is_ultra_restricted")) db.exec("ALTER TABLE userlist ADD COLUMN is_ultra_restricted INTEGER");

    // Backfill flags for rows already in the DB (only where the flag is still NULL)
    const backfill = db.prepare("SELECT id, user_json FROM userlist WHERE is_admin IS NULL OR is_restricted IS NULL OR deleted IS NULL OR is_ultra_restricted IS NULL").all();
    if (backfill.length) {
      const upd = db.prepare("UPDATE userlist SET is_admin = ?, is_restricted = ?, deleted = ?, is_ultra_restricted = ? WHERE id = ?");
      db.exec("BEGIN");
      try {
        for (const r of backfill) {
          let j = {};
          try { j = JSON.parse(r.user_json) || {}; } catch {}
          const b = v => (v === true ? 1 : v === false ? 0 : null);
          upd.run(b(j.is_admin), b(j.is_restricted), b(j.deleted), b(j.is_ultra_restricted), r.id);
        }
        db.exec("COMMIT");
        log("info", `Backfilled user flags for ${backfill.length} existing user rows.`);
      } catch (e) {
        db.exec("ROLLBACK");
        log("error", `Flag backfill failed: ${e.message}`);
      }
    }
    
    db.prepare("UPDATE send_jobs SET status = 'failed' WHERE status = 'running'").run();
    log("info", "Database initialized successfully.");

  } catch (e) { log("error", `Migration error: ${e.message}`); throw e; }
}

function getWorkspaceRows(db) {
  return db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM accounts a WHERE a.workspace_id = w.id) AS account_count, (SELECT COUNT(*) FROM userlist u WHERE u.workspace_id = w.id) AS fetched_count, (SELECT COUNT(*) FROM sent_users s WHERE s.workspace_id = w.id) AS sent_count FROM workspaces w ORDER BY w.id DESC`).all().map(r => ({ ...r, done: r.cursor === null && r.next_page > 1 }));
}

function getAccountRows(db) {
  return db.prepare(`SELECT a.id, a.workspace_id, a.account_name, a.ai_type, a.api_key, w.workspace_name FROM accounts a JOIN workspaces w ON w.id = a.workspace_id ORDER BY a.id DESC`).all();
}

function getEarliestAccount(db, workspaceId) {
  return db.prepare(`SELECT * FROM accounts WHERE workspace_id = ? ORDER BY id ASC LIMIT 1`).get(workspaceId);
}

// Map an incoming "yes"/"no"/"" filter value to a SQL boolean predicate for a flag column.
function flagPredicate(col, val) {
  if (val === "yes") return `u.${col} = 1`;
  if (val === "no") return `COALESCE(u.${col}, 0) = 0`;
  return null;
}

function getUsersSearch(db, filters) {
  const w = [], p = [];
  if (filters.workspaceId) { w.push("u.workspace_id = ?"); p.push(filters.workspaceId); }
  if (filters.sent === "yes") w.push("s.user_id IS NOT NULL AND COALESCE(s.skipped,0) = 0");
else if (filters.sent === "no") w.push("s.user_id IS NULL");
else if (filters.sent === "skip") w.push("COALESCE(s.skipped,0) = 1");
  if (filters.accountId) { w.push("s.account_id = ?"); p.push(Number(filters.accountId)); }
  if (filters.userId) { w.push("u.user_id LIKE ?"); p.push(`%${filters.userId}%`); }
  if (filters.displayName) { w.push("LOWER(u.user_json) LIKE ?"); p.push(`%${filters.displayName.toLowerCase()}%`); }
  if (filters.sentAtFrom) { w.push("s.sent_at >= ?"); p.push(filters.sentAtFrom); }
  if (filters.sentAtTo) { w.push("s.sent_at <= ?"); p.push(filters.sentAtTo + " 23:59:59"); }
  
  if (filters.status) { w.push("COALESCE(s.status, 'alive') = ?"); p.push(filters.status); }
  if (filters.reply) { w.push("COALESCE(s.reply, 'no') = ?"); p.push(filters.reply); }

  // --- New: Slack account flag filters ---
  const flagFilters = [
    ["is_admin", filters.isAdmin],
    ["is_restricted", filters.isRestricted],
    ["deleted", filters.deleted],
    ["is_ultra_restricted", filters.isUltraRestricted],
  ];
  for (const [col, val] of flagFilters) {
    const pred = flagPredicate(col, val);
    if (pred) w.push(pred);
  }

  const wSql = w.length ? `WHERE ${w.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS c FROM userlist u LEFT JOIN sent_users s ON s.workspace_id = u.workspace_id AND s.user_id = u.user_id ${wSql}`).get(...p).c;

  const rows = db.prepare(`
    SELECT u.id AS row_id, u.user_id, u.user_json, u.workspace_id, w.workspace_name, w.slack_route,
           u.is_admin, u.is_restricted, u.deleted, u.is_ultra_restricted,
           s.sent_at, s.account_id, s.score, s.threshold, s.ai_prompt, s.message, s.ai_response,
           s.dm_url, s.status, s.reply, a.account_name ,s.skipped
    FROM userlist u
    LEFT JOIN sent_users s ON s.workspace_id = u.workspace_id AND s.user_id = u.user_id
    LEFT JOIN accounts a ON a.id = s.account_id
    LEFT JOIN workspaces w ON w.id = u.workspace_id
    ${wSql} ORDER BY u.id ASC LIMIT ? OFFSET ?
  `).all(...p, filters.limit, (filters.page - 1) * filters.limit);

  return { total, rows };
}

function saveFetchedPage(db, workspaceId, page, pagination, items, nextCursor) {
  const st = db.prepare(`
    INSERT INTO userlist (workspace_id, user_id, user_json, fetched_page, is_admin, is_restricted, deleted, is_ultra_restricted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, user_id) DO UPDATE SET
      user_json = excluded.user_json,
      fetched_page = excluded.fetched_page,
      is_admin = excluded.is_admin,
      is_restricted = excluded.is_restricted,
      deleted = excluded.deleted,
      is_ultra_restricted = excluded.is_ultra_restricted
  `);
  const b = v => (v === true ? 1 : v === false ? 0 : null);
  db.exec("BEGIN");
  try {
    for (const i of items) {
      if (i && i.id) {
        st.run(workspaceId, i.id, JSON.stringify(i), page,
          b(i.is_admin), b(i.is_restricted), b(i.deleted), b(i.is_ultra_restricted));
      }
    }
    db.prepare(`UPDATE workspaces SET page_count = ?, total_count = ?, next_page = ?, cursor = ? WHERE id = ?`)
      .run(pagination.page_count, pagination.total_count, page + 1, nextCursor, workspaceId);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

async function readJsonBody(req) {
  const c = []; let s = 0;
  for await (const chunk of req) { s += chunk.length; if (s > MAX_BODY_BYTES) throw new Error("Too large"); c.push(chunk); }
  try { return JSON.parse(Buffer.concat(c).toString("utf8")); } catch { throw new Error("Invalid JSON"); }
}

function sendJson(res, code, val) {
  res.writeHead(code, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(val));
}

function isSameOrigin(req) {
  const p = String(req.socket.localPort);
  return [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`].includes(req.headers.host) && [`http://127.0.0.1:${p}`, `http://localhost:${p}`, `http://[::1]:${p}`].includes(req.headers.origin);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getValidApiKey(db, account, aiType) {
  const keys = account.api_key.split("\n").map(k => k.trim()).filter(Boolean);
  if (!keys.length) throw new Error("No API keys configured.");
  
  const now = new Date().toISOString();
  const cooling = db.prepare("SELECT api_key FROM key_cooldowns WHERE cooldown_until > ?").all(now).map(r => r.api_key);
  
  const available = keys.filter(k => !cooling.includes(k));
  if (!available.length) {
    const next = db.prepare("SELECT cooldown_until FROM key_cooldowns WHERE api_key IN (" + keys.map(()=>"?").join(",") + ") ORDER BY cooldown_until ASC LIMIT 1").get(...keys);
    throw new Error(`All keys exhausted. Next available after ${next ? next.cooldown_until : "unknown"}`);
  }
  
  return { key: available[0], totalAvailable: available.length };
}

function markKeyCooldown(db, key) {
  const cooldownUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare("INSERT OR REPLACE INTO key_cooldowns (api_key, cooldown_until) VALUES (?, ?)").run(key, cooldownUntil);
}

async function callMistral(key, prompt) {
  const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({ model: MISTRAL_MODEL, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(await r.text());
  const d = await r.json();
  return d.choices[0].message.content.trim();
}

async function callOpenAI(key, prompt) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(await r.text());
  const d = await r.json();
  return d.choices[0].message.content.trim();
}

async function callGemini(key, prompt) {
  const u = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }) });
  if (!r.ok) throw new Error(await r.text());
  const d = await r.json();
  return d.candidates[0].content.parts[0].text.trim();
}

async function callAi(db, aiType, account, prompt) {
  const { key, totalAvailable } = getValidApiKey(db, account, aiType);
  try {
    if (aiType === "openai") return await callOpenAI(key, prompt);
    if (aiType === "gemini") return await callGemini(key, prompt);
    return await callMistral(key, prompt);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes("429") || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("rate limit") || msg.includes("exhausted")) {
      markKeyCooldown(db, key);
      log("warn", `Rate limit hit on key. Cooldown applied. ${totalAvailable-1} left.`);
      throw new Error(`Rate limit hit on key (${totalAvailable-1} left). Cooldown applied.`);
    }
    log("error", `AI API Error: ${msg}`);
    throw e;
  }
}

function evaluateFilter(code, user) {
  const wrapper = `
    (function() {
      let __r, __s, __t;
      try { __r = (function() { ${code} })(); } catch (e) { return { err: e.message }; }
      try {
        const c = (function() { ${code.replace(/return\s+[^;]*;?\s*$/m, "")} return { s: typeof score !== 'undefined' ? score : undefined, t: typeof threshold !== 'undefined' ? threshold : undefined }; })();
        __s = c.s; __t = c.t;
      } catch (_) {}
      return { res: __r, s: __s, t: __t };
    })()`;
  try {
    const out = vm.runInContext(wrapper, vm.createContext({ user }), { timeout: 2000 });
    if (out.err) return { passed: false, score: null, threshold: null };
    return { passed: out.res === true, score: Number.isFinite(out.s) ? out.s : null, threshold: Number.isFinite(out.t) ? out.t : null };
  } catch { return { passed: false, score: null, threshold: null }; }
}

const runningJobs = new Map();
const pausedJobs = new Map();
const activeUsers = new Set();

function createServer({ upstreamFetch = fetch, dbPath = DB_PATH } = {}) {
  const db = new DatabaseSync(dbPath);
  initializeDatabase(db);
  const activeFetches = new Map();

  const server = http.createServer(async (req, res) => {
    // CORS for extension
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      return res.end();
    }

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");

    if (req.method === "GET" && req.url === "/") { res.writeHead(200, {"Content-Type": "text/html"}); return res.end(await readFile(INDEX_PATH)); }
    if (req.method === "GET" && req.url === "/client.js") { res.writeHead(200, {"Content-Type": "text/javascript"}); return res.end(await readFile(CLIENT_PATH)); }
    
    if (req.method === "GET" && req.url.startsWith("/api/logs")) {
      const u = new URL(req.url, "http://x");
      const after = Number(u.searchParams.get("after") || 0);
      const newLogs = logBuffer.filter(l => l.id > after);
      return sendJson(res, 200, { logs: newLogs });
    }

    if (req.method === "GET" && req.url === "/api/workspaces") return sendJson(res, 200, { workspaces: getWorkspaceRows(db) });
    if (req.method === "GET" && req.url === "/api/accounts") return sendJson(res, 200, { accounts: getAccountRows(db) });
    
    if (req.method === "GET" && req.url === "/api/draft") {
      const r = db.prepare("SELECT message_template, filter_script, ai_prompt, ai_prompts FROM draft WHERE id = 1").get();
      return sendJson(res, 200, { messageTemplate: r?.message_template || "", filterScript: r?.filter_script || "", aiPrompt: r?.ai_prompt || "", aiPrompts: JSON.parse(r?.ai_prompts || "{}") });
    }
    
    if (req.method === "GET" && req.url.startsWith("/api/users")) {
try {
      const u = new URL(req.url, "http://x");
      const filters = {
        page: Number(u.searchParams.get("page") || 1),
        limit: Number(u.searchParams.get("limit") || 20),
        workspaceId: u.searchParams.get("workspace_id") ? Number(u.searchParams.get("workspace_id")) : null,
        sent: u.searchParams.get("sent") || "",
        accountId: u.searchParams.get("account_id") || "",
        userId: u.searchParams.get("user_id") || "",
        displayName: u.searchParams.get("display_name") || "",
        sentAtFrom: u.searchParams.get("sent_at_from") || "",
        sentAtTo: u.searchParams.get("sent_at_to") || "",
        status: u.searchParams.get("status") || "",
        reply: u.searchParams.get("reply") || "",
        // --- New flag filters ---
        isAdmin: u.searchParams.get("is_admin") || "",
        isRestricted: u.searchParams.get("is_restricted") || "",
        deleted: u.searchParams.get("deleted") || "",
        isUltraRestricted: u.searchParams.get("is_ultra_restricted") || "",
      };
      const { total, rows } = getUsersSearch(db, filters);
      return sendJson(res, 200, {
        page: filters.page, limit: filters.limit, total, pageCount: Math.max(1, Math.ceil(total / filters.limit)),
        users: rows.map(r => {
          let dn = ""; try { const j = JSON.parse(r.user_json); dn = j?.profile?.display_name || j?.profile?.real_name || j?.real_name || ""; } catch {}
          return { 
            workspace_id: r.workspace_id, workspace_name: r.workspace_name, slack_route: r.slack_route, 
            user_id: r.user_id, display_name: dn, user_json: r.user_json, is_sent: r.sent_at !== null && !r.skipped, skipped: !!r.skipped,
            sent_at: r.sent_at, account_name: r.account_name, 
            score: r.score, threshold: r.threshold, ai_prompt: r.ai_prompt, message: r.message, ai_response: r.ai_response,
            dm_url: r.dm_url, status: r.status, reply: r.reply,
            is_admin: r.is_admin, is_restricted: r.is_restricted, deleted: r.deleted, is_ultra_restricted: r.is_ultra_restricted,
          };
        })
      });
}catch(e){
 log("error", `Users query failed: ${e.message}`);
    return sendJson(res, 500, { error: e.message });
}
    }

    if (req.method === "POST" && req.url === "/reply_add") {
      try {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.users)) return sendJson(res, 400, { error: "Missing users array" });
        
        db.exec("BEGIN");
        try {
          for (const u of body.users) {
            const userId = u.user_id; 
            if (!userId) continue;

            let wsId = null;
            if (u.workspace_id) {
              const ws = db.prepare("SELECT id FROM workspaces WHERE slack_route = ?").get(u.workspace_id);
              if (ws) wsId = ws.id;
            }

            if (!wsId) {
              const existing = db.prepare("SELECT workspace_id FROM userlist WHERE user_id = ? LIMIT 1").get(userId);
              if (existing) wsId = existing.workspace_id;
            }

            if (wsId) {
              db.prepare(`
                                INSERT INTO sent_users (workspace_id, user_id, dm_url, reply, status) 
                VALUES (?, ?, ?, 'yes', 'alive')
                ON CONFLICT(workspace_id, user_id) DO UPDATE SET
                  dm_url = excluded.dm_url,
                  reply = 'yes',
                  status = 'alive'
                WHERE status != 'dead'
              `).run(wsId, userId, u.dm_url || null);
              log("info", `Reply tracked for user ${userId} in workspace ${wsId}`);
            }
          }
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        res.writeHead(200); res.end();
      } catch (e) {
        log("error", `Reply Add Error: ${e.message}`);
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/reply_delete") {
      try {
        const body = await readJsonBody(req);
        if (!body.user_id) return sendJson(res, 400, { error: "Missing user_id" });
        
        let wsId = null;
        if (body.workspace_id) {
          const ws = db.prepare("SELECT id FROM workspaces WHERE slack_route = ?").get(body.workspace_id);
          if (ws) wsId = ws.id;
        }

        if (!wsId) {
          const existing = db.prepare("SELECT workspace_id FROM userlist WHERE user_id = ? LIMIT 1").get(body.user_id);
          if (existing) wsId = existing.workspace_id;
        }

        if (wsId) {
          db.prepare(`
            UPDATE sent_users SET status = 'dead' 
            WHERE workspace_id = ? AND user_id = ? AND status != 'dead'
          `).run(wsId, body.user_id);
          log("info", `User ${body.user_id} marked as dead in workspace ${wsId}`);
        }
        res.writeHead(200); res.end();
      } catch (e) {
        log("error", `Reply Delete Error: ${e.message}`);
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    if (req.method === "GET" && req.url === "/api/send-jobs") {
      const jobs = db.prepare(`
        SELECT j.*, w.workspace_name, a.account_name,
               (SELECT COUNT(*) FROM userlist u WHERE u.workspace_id = j.workspace_id) AS total,
               (SELECT COUNT(*) FROM sent_users s WHERE s.workspace_id = j.workspace_id) AS workspace_sent
        FROM send_jobs j 
        JOIN workspaces w ON w.id = j.workspace_id 
        JOIN accounts a ON a.id = j.account_id 
        ORDER BY j.id DESC
      `).all();
      return sendJson(res, 200, { jobs });
    }

    if (req.method === "POST" && req.url === "/api/send-jobs") {
      const input = await readJsonBody(req);
      db.prepare("INSERT INTO send_jobs (workspace_id, account_id, count) VALUES (?, ?, ?)").run(input.workspace_id, input.account_id, input.count);
      log("info", `Created new send job for workspace ${input.workspace_id}`);
      return sendJson(res, 200, { success: true });
    }
    
    if (req.method === "PUT" && req.url.startsWith("/api/send-jobs/") && !req.url.endsWith("/start") && !req.url.endsWith("/stop")) {
      const id = Number(req.url.split("/").pop());
      const input = await readJsonBody(req);
      if (input.count != null) {
        db.prepare("UPDATE send_jobs SET count = ? WHERE id = ?").run(input.count, id);
      }
      return sendJson(res, 200, { success: true });
    }
    
    if (req.method === "POST" && req.url.startsWith("/api/send-jobs/") && req.url.endsWith("/start")) {
      const id = Number(req.url.split("/")[3]);
      const job = db.prepare("SELECT * FROM send_jobs WHERE id = ?").get(id);
      if (!job) return sendJson(res, 404, { error: "Job not found" });
      
      const input = await readJsonBody(req);
      
      const isResume = job.status === "paused";
      if (!isResume) {
          db.prepare("UPDATE send_jobs SET sent_count = 0 WHERE id = ?").run(id);
      }

      db.prepare("UPDATE send_jobs SET status = 'running' WHERE id = ?").run(id);
      
      const controller = new AbortController();
      runningJobs.set(id, controller);

      const saved = pausedJobs.get(id);
      processSendJob(db, job, input, upstreamFetch, controller.signal, isResume ? job.sent_count : 0, isResume ? saved : null).catch(err => {
        log("error", `Job failed: ${err.message}`);
        db.prepare("UPDATE send_jobs SET status = 'failed' WHERE id = ?").run(id);
        db.prepare("INSERT INTO send_logs (workspace_id, account_id, count, status) VALUES (?, ?, ?, ?)").run(job.workspace_id, job.account_id, job.count, "Failed: " + err.message);
        runningJobs.delete(id);
      });
      
      return sendJson(res, 200, { success: true });
    }

    if (req.method === "POST" && req.url.startsWith("/api/send-jobs/") && req.url.endsWith("/stop")) {
      const id = Number(req.url.split("/")[3]);
      const controller = runningJobs.get(id);
      if (controller) {
        controller.abort();
        runningJobs.delete(id);
        db.prepare("UPDATE send_jobs SET status = 'paused' WHERE id = ?").run(id);
        log("info", `Job ${id} paused by user.`);
      }
      return sendJson(res, 200, { success: true });
    }
    
    if (req.method === "DELETE" && req.url.startsWith("/api/send-jobs/")) {
      const id = Number(req.url.split("/").pop());
      db.prepare("DELETE FROM send_jobs WHERE id = ?").run(id);
      return sendJson(res, 200, { success: true });
    }

    if (req.method === "POST" && req.url === "/api/draft") {
      const i = await readJsonBody(req);
      const ap = {};
      if (i.aiPrompts) { for (const [k, v] of Object.entries(i.aiPrompts)) { if (/^\d+$/.test(k)) ap[k] = String(v||""); } }
      db.prepare(`INSERT INTO draft (id, message_template, filter_script, ai_prompt, ai_prompts) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET message_template=excluded.message_template, filter_script=excluded.filter_script, ai_prompt=excluded.ai_prompt, ai_prompts=excluded.ai_prompts`).run(i.messageTemplate||"", i.filterScript||"", i.aiPrompt||"", JSON.stringify(ap));
      return sendJson(res, 200, { success: true });
    }

    if (req.method === "POST" && req.url === "/api/workspaces") {
      const i = await readJsonBody(req);
      const e = validateWorkspaceInput(i); if (e) return sendJson(res, 400, { error: e });
      const r = db.prepare("INSERT INTO workspaces (upstream, slack_route, workspace_name) VALUES (?, ?, ?)").run(new URL(i.upstream).origin, i.slack_route, i.workspace_name);
      log("info", `Registered workspace ${i.workspace_name}`);
      return sendJson(res, 200, { id: r.lastInsertRowid });
    }

    if (req.method === "POST" && req.url === "/api/accounts") {
      const i = await readJsonBody(req);
      const e = validateAccountInput(i); if (e) return sendJson(res, 400, { error: e });
      const r = db.prepare("INSERT INTO accounts (workspace_id, account_name, ai_type, api_key, cookie, token) VALUES (?, ?, ?, ?, ?, ?)").run(i.workspace_id, i.account_name, i.ai_type, i.api_key, i.cookie, i.token);
      log("info", `Registered account ${i.account_name}`);
      return sendJson(res, 200, { id: r.lastInsertRowid });
    }
    
    if (req.method === "PUT" && req.url.startsWith("/api/accounts/")) {
      const id = Number(req.url.split("/").pop());
      const i = await readJsonBody(req);
      db.prepare("UPDATE accounts SET api_key = ? WHERE id = ?").run(i.api_key, id);
      return sendJson(res, 200, { success: true });
    }
    
    if (req.method === "DELETE" && req.url.startsWith("/api/accounts/")) {
      const id = Number(req.url.split("/").pop());
      db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
      log("info", `Deleted account ${id}`);
      return sendJson(res, 200, { success: true });
    }

    if (req.method === "DELETE" && req.url.startsWith("/api/workspaces/")) {
      const id = Number(req.url.split("/").pop());
      db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
      log("info", `Deleted workspace ${id}`);
      return sendJson(res, 200, { success: true });
    }

    if (req.method === "POST" && req.url.endsWith("/fetch")) {
      const id = Number(req.url.split("/")[3]);
      const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
      if (!ws) return sendJson(res, 404, { error: "Not found" });
      if (ws.next_page > 1 && ws.cursor === null) return sendJson(res, 200, { done: true });

      const acc = getEarliestAccount(db, id);
      if (!acc) return sendJson(res, 400, { error: "No account." });

      const reqData = buildUsersListRequest({ upstream: ws.upstream, slack_route: ws.slack_route, cookie: acc.cookie, token: acc.token, cursor: ws.cursor });
      try {
        const r = await upstreamFetch(reqData.url, { method: "POST", headers: reqData.headers, body: reqData.body });
        if (!r.ok) throw new Error(`Slack HTTP ${r.status}`);
        
        const j = JSON.parse(await r.text());
        if (!j.ok) throw new Error(j.error || "Failed users.list");
        
        const items = (j.members || []).filter(m => !m.is_bot && m.id !== "USLACKBOT");
        const nextCursor = j.response_metadata?.next_cursor || null;
        const done = !nextCursor;
        
        saveFetchedPage(db, id, ws.next_page, { page_count: ws.next_page, total_count: items.length }, items, nextCursor);
        log("info", `Fetched page ${ws.next_page} for workspace ${id} (${items.length} users)`);
        return sendJson(res, 200, { page: ws.next_page, pageCount: ws.next_page, received: items.length, done });
      } catch (e) { 
        log("error", `Fetch failed: ${e.message}`);
        return sendJson(res, 502, { error: e.message }); 
      }
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.on("close", () => db.close());
  return server;
}

async function processSendJob(db, job, input, fetchFn, signal, startIndex, savedState) {
  const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(job.workspace_id);
  const acc = db.prepare("SELECT * FROM accounts WHERE id = ?").get(job.account_id);
  if (!ws || !acc) throw new Error("Config missing");

  let succ = startIndex || 0, fail = 0, skip = 0;
  const delay = input.delayMs || 1000;
  const filterCode = input.filterScript.trim() || "return true;";
  
  const markStmt = db.prepare(`INSERT OR IGNORE INTO sent_users (workspace_id, user_id, account_id, score, threshold, ai_prompt, message, ai_response) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateStmt = db.prepare(`UPDATE sent_users SET score=?, threshold=?, ai_prompt=?, message=?, ai_response=? WHERE workspace_id=? AND user_id=?`);

  const processedUsers = new Set(savedState?.processedUsers || []);
  
  // Loop until we reach the requested count or run out of users
  while (succ < job.count) {
    if (signal.aborted) {
      pausedJobs.set(job.id, { processedUsers });
      throw new Error("Aborted");
    }

    // 1. Fetch the NEXT available user from the database (only one at a time)
    let u = db.prepare(`
      SELECT u.user_id, u.user_json 
      FROM userlist u 
      LEFT JOIN sent_users s ON u.workspace_id = s.workspace_id AND u.user_id = s.user_id 
      WHERE u.workspace_id = ? AND s.user_id IS NULL 
      ORDER BY u.id ASC LIMIT 1
    `).get(job.workspace_id);

    if (!u) break; // No more users left in this workspace

    // 2. Synchronously check and lock the user
    const lockKey = `${job.workspace_id}:${u.user_id}`;
    if (activeUsers.has(lockKey)) {
      // Another account grabbed this user in the last millisecond.
      // Wait a moment and try again to grab the next one.
      await sleep(100);
      continue;
    }

    // Lock it immediately
    activeUsers.add(lockKey);

    try {
      let obj; 
      try { obj = JSON.parse(u.user_json); } catch { obj = null; }
      
      const f = evaluateFilter(filterCode, obj);
      if (!f.passed) {
  skip++;
  processedUsers.add(u.user_id);
  // Record skip with score/threshold, flag as skipped (not a real send)
  markStmt.run(job.workspace_id, u.user_id, acc.id, f.score, f.threshold, null, null, null);
  updateStmt.run(f.score, f.threshold, null, null, null, job.workspace_id, u.user_id);
  db.prepare(`UPDATE sent_users SET skipped = 1 WHERE workspace_id = ? AND user_id = ?`).run(job.workspace_id, u.user_id);
  continue;
}
      
      let msg = input.messageTemplate, aiAns = null, req = null;
      if (/\{AI_answer\}/.test(msg)) {
        const resolved = resolveAiComposer(input.aiPrompt, obj, input.aiPrompts);
        req = `You are an assistant tasked with writing a short, professional Slack direct message.\n\nHere are the instructions and context to generate the message:\n"""\n${resolved}\n"""\n\nPlease write only the final message text based on the instructions above. Do not include any explanations or quotes.`;
        
        try {
          aiAns = await callAi(db, acc.ai_type, acc, req);
        } catch (e) { 
          fail++; 
          log("error", `AI generation failed for ${u.user_id}: ${e.message}`);
          await sleep(2000); 
          continue; 
        }
      }

      const map = buildTemplateMapping(obj, aiAns);
      msg = renderTemplate(msg, map);
      
      const cReq = buildChatRequest({ upstream: ws.upstream, slack_route: ws.slack_route, cookie: acc.cookie, token: acc.token, userId: u.user_id, messageText: msg });
      
      try {
        const r = await fetchFn(cReq.url, { method: "POST", headers: cReq.headers, body: cReq.body, signal });
        const txt = await r.text(); 
        let j = {}; 
        try { j = JSON.parse(txt); } catch {}
        
        if (j.ok === true) {
  succ++;
  processedUsers.add(u.user_id);
  markStmt.run(job.workspace_id, u.user_id, acc.id, f.score, f.threshold, req, msg, aiAns);
  updateStmt.run(f.score, f.threshold, req, msg, aiAns, job.workspace_id, u.user_id);
  db.prepare("UPDATE sent_users SET skipped = 0 WHERE workspace_id = ? AND user_id = ?").run(job.workspace_id, u.user_id);
  db.prepare("UPDATE send_jobs SET sent_count = ? WHERE id = ?").run(succ, job.id);
} else { 
          fail++; 
          log("error", `Slack send error for ${u.user_id}: ${j.error}`); 
        }
      } catch (e) { 
        if (signal.aborted) {
           pausedJobs.set(job.id, { processedUsers });
           throw new Error("Aborted");
        }
        fail++; 
        log("error", `Network error sending to ${u.user_id}: ${e.message}`); 
      }
    } finally {
      // Always release the lock when done with this user
      activeUsers.delete(lockKey);
    }

    await sleep(delay);
  }

  db.prepare("UPDATE send_jobs SET status = 'completed' WHERE id = ?").run(job.id);
  pausedJobs.delete(job.id);
  db.prepare("INSERT INTO send_logs (workspace_id, account_id, count, status) VALUES (?, ?, ?, ?)").run(job.workspace_id, job.account_id, succ, `Success: ${succ}, Failed: ${fail}, Skipped: ${skip}`);
  log("info", `Job ${job.id} completed: ${succ} success, ${fail} failed, ${skip} skipped.`);
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, "127.0.0.1", () => {
    log("info", `Server listening at http://127.0.0.1:${PORT}`);
  });
  server.on("error", (error) => {
    log("error", `Server error: ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { buildChatRequest, createServer };