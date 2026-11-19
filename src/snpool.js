// sn / secret pool.
//
// Records live in KV (no hard-coded pool any more):
//   {
//     sn, secret,
//     note,
//     status:    "active" | "disabled" | "dead",  // dead = login rejected
//     lastCheck: ms, lastError: "", lastErrorAt: ms, lastOkAt: ms,
//     lastUsed:  ms, failWindow: [ms, ...]   // recent failure timestamps
//     okCount, failCount,
//     cooldownUntil: ms,     // set when upstream returns the opaque failure
//     createdAt
//   }
//
// Rotation: `pick()` walks the pool in round-robin order, skipping disabled /
// dead / cooling-down entries. A failed turn calls `markFailure(sn)` which puts
// that device on a short cooldown so retries land on a different device.

import {
  del,
  getJSON,
  indexAdd,
  indexList,
  indexRemove,
  putJSON,
  PREFIX,
} from "./store.js";
import { login, loginDetailed } from "./upstream.js";

const COOLDOWN_MS = 60 * 1000;
// 上游按天配额，命中 4001「今日次数已用完」时摘除到第二天 0 点（本地时间）。
function nextMidnight() {
  const d = new Date();
  d.setHours(24, 0, 5, 0);
  return d.getTime();
}
// Sliding window used to decide whether a device is "currently flaky".
const FAIL_WINDOW_MS = 5 * 60 * 1000;

export function parseImport(text) {
  // One pair per line, sn and secret separated by whitespace.
  const out = [];
  const seen = new Set();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const sn = parts[0];
    const secret = parts[1];
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(secret)) continue;
    if (seen.has(sn)) continue;
    seen.add(sn);
    out.push({ sn, secret, note: parts.slice(2).join(" ").slice(0, 200) });
  }
  return out;
}

// ---- pool snapshot + in-process cache --------------------------------------
// 每次请求都全量 GET 一遍设备（索引 + 逐条）成本太高。用一个进程内缓存 +
// 单条快照记录把"读池"降到最多 1 次 KV 往返。
const POOL_CACHE_MS = 5000;
let poolCache = { at: 0, list: null };
const SNAPSHOT_KEY = "sn:__pool__";

export function invalidatePool() {
  poolCache = { at: 0, list: null };
}

async function writeSnapshot(env, list) {
  try {
    await putJSON(env, SNAPSHOT_KEY, list, 0);
  } catch {
    // 快照失败不影响主流程
  }
}

export async function listCredentials(env) {
  const now = Date.now();
  if (poolCache.list && now - poolCache.at < POOL_CACHE_MS) return poolCache.list;
  // 优先读单条快照
  const snap = await getJSON(env, SNAPSHOT_KEY, null);
  if (Array.isArray(snap) && snap.length > 0) {
    poolCache = { at: now, list: snap };
    return snap;
  }
  return listCredentialsSlow(env);
}

export async function listCredentialsSlow(env) {
  const sns = await indexList(env, PREFIX.SN_IDX);
  const out = [];
  for (const sn of sns) {
    const rec = await getJSON(env, PREFIX.SN + sn, null);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  // 回填快照与进程内缓存，下次请求直接命中
  if (out.length > 0) {
    await writeSnapshot(env, out);
    poolCache = { at: Date.now(), list: out };
  }
  return out;
}

export async function getCredential(env, sn) {
  return getJSON(env, PREFIX.SN + sn, null);
}

export async function putCredential(env, rec) {
  await putJSON(env, PREFIX.SN + rec.sn, rec, 0);
  await indexAdd(env, PREFIX.SN_IDX, rec.sn);
  // 让下一次读取重建快照
  invalidatePool();
  try {
    const snap = await getJSON(env, SNAPSHOT_KEY, null);
    if (Array.isArray(snap)) {
      const idx = snap.findIndex((r) => r && r.sn === rec.sn);
      if (idx >= 0) snap[idx] = rec;
      else snap.push(rec);
      await writeSnapshot(env, snap);
    }
  } catch {
    // 快照更新失败时下次会退化为全量读取
  }
  return rec;
}

export async function addCredential(env, { sn, secret, note = "", allowUpdate = false }) {
  const existing = await getCredential(env, sn);
  if (existing && !allowUpdate) {
    const err = new Error(`sn ${sn} already exists`);
    err.code = "duplicate_sn";
    throw err;
  }
  const rec = {
    ...(existing || {}),
    sn,
    secret,
    note: note !== undefined ? String(note).slice(0, 200) : existing?.note || "",
    status: existing?.status === "dead" ? "active" : existing?.status || "active",
    lastCheck: existing?.lastCheck || 0,
    lastError: existing?.lastError || "",
    lastErrorAt: existing?.lastErrorAt || 0,
    lastOkAt: existing?.lastOkAt || 0,
    lastUsed: existing?.lastUsed || 0,
    failWindow: Array.isArray(existing?.failWindow) ? existing.failWindow : [],
    okCount: existing?.okCount || 0,
    failCount: existing?.failCount || 0,
    cooldownUntil: 0,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  return putCredential(env, rec);
}

export async function deleteCredential(env, sn) {
  await del(env, PREFIX.SN + sn);
  await indexRemove(env, PREFIX.SN_IDX, sn);
  await del(env, PREFIX.USAGE_SN + sn);
  invalidatePool();
  try {
    const snap = await getJSON(env, SNAPSHOT_KEY, null);
    if (Array.isArray(snap)) await writeSnapshot(env, snap.filter((r) => r && r.sn !== sn));
  } catch {
    // ignore
  }
}

export async function importCredentials(env, text) {
  const pairs = parseImport(text);
  const added = [];
  const skipped = [];
  const duplicates = [];
  for (const p of pairs) {
    // 批量导入：重复的静默跳过，不报错
    if (await getCredential(env, p.sn)) {
      duplicates.push(p.sn);
      continue;
    }
    try {
      await addCredential(env, p);
      added.push(p.sn);
    } catch (e) {
      skipped.push({ sn: p.sn, reason: e.message });
    }
  }
  return { added, skipped, duplicates, total: pairs.length };
}

// Rotation cursor (process-local). Fine for a single isolate; the pool order is
// authoritative in KV.
let cursor = 0;

// 额度耗尽的判断与冷却分开：即使手动清了冷却，当天用尽的设备也不该再被选中。
function sameLocalDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function isUsable(rec, now = Date.now()) {
  if (!rec || !rec.sn || !rec.secret) return false;
  if (rec.status === "disabled" || rec.status === "dead") return false;
  // binded=0 的设备能登录但回答会报 "cid or passportId from iotserver = 0"，
  // 直接排除，避免白白消耗请求。
  if (rec.binded === 0) return false;
  if (rec.halted) return false;
  if (rec.quotaExhaustedAt && sameLocalDay(rec.quotaExhaustedAt, now)) return false;
  if (rec.cooldownUntil && now < rec.cooldownUntil) return false;
  return true;
}

// 供管理端/批量恢复使用：清冷却时是否连额度标记一起清（默认不清）。
export function clearCooldownState(rec, { includeQuota = false } = {}) {
  rec.cooldownUntil = 0;
  rec.failWindow = [];
  rec.lastError = "";
  if (includeQuota) rec.quotaExhaustedAt = 0;
  return rec;
}

export async function pick(env, { preferSn = "", avoidSn = "" } = {}) {
  const all = await listCredentials(env);
  if (all.length === 0) throw new Error("sn pool is empty; add one in /admin");

  if (preferSn) {
    const hit = all.find((r) => r.sn === preferSn && isUsable(r));
    if (hit) return hit;
  }
  const usable = all.filter((r) => isUsable(r) && r.sn !== avoidSn);
  const pool = usable.length > 0 ? usable : all.filter((r) => isUsable(r));
  if (pool.length > 0) {
    cursor = (cursor + 1) % pool.length;
    return pool[cursor % pool.length];
  }

  // 全部在冷却：退一步，选「最容易恢复」的一台（冷却最早结束 / 最近成功过的）。
  // 冷却只是防止连续打同一台，不该让整个服务停摆。
  const candidates = all.filter((r) => r.status !== "disabled" && r.status !== "dead");
  if (candidates.length > 0) {
    const best = candidates.sort((a, b) => {
      const ca = a.cooldownUntil || 0;
      const cb = b.cooldownUntil || 0;
      if (ca !== cb) return ca - cb;
      return (b.lastOkAt || 0) - (a.lastOkAt || 0);
    })[0];
    return best;
  }
  throw new Error("no usable sn in pool (all disabled/dead)");
}

export async function markSuccess(env, sn) {
  const rec = await getCredential(env, sn);
  if (!rec) return;
  const now = Date.now();
  rec.okCount = (rec.okCount || 0) + 1;
  rec.lastUsed = now;
  rec.lastOkAt = now;
  rec.cooldownUntil = 0;
  rec.quotaExhaustedAt = 0;
  rec.failWindow = (rec.failWindow || []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (rec.status === "dead") rec.status = "active";
  await putCredential(env, rec);
}

export async function markFailure(env, sn, message = "", { dead = false, quotaExhausted = false } = {}) {
  const rec = await getCredential(env, sn);
  if (!rec) return;
  const now = Date.now();
  rec.failCount = (rec.failCount || 0) + 1;
  rec.lastError = String(message || "").slice(0, 200);
  rec.lastErrorAt = now;
  rec.lastCheck = now;
  rec.failWindow = [...(rec.failWindow || []).filter((t) => now - t < FAIL_WINDOW_MS), now];
  if (dead) {
    rec.status = "dead";
  } else if (quotaExhausted) {
    // 配额耗尽：不是故障，是"今天用完了"。摘到明天 0 点，期间不参与轮换。
    rec.quotaExhaustedAt = now;
    rec.cooldownUntil = nextMidnight();
    rec.lastError = "今日次数已用完，明日自动恢复";
  } else {
    rec.cooldownUntil = now + COOLDOWN_MS;
  }
  await putCredential(env, rec);
}

// Availability probe: try a real device login. Updates status/lastCheck.
// 真实可用性探测：登录（验 secret/绑定）+ 一次真实对话（验限流/额度）。
// 只做登录测不出"今日次数已用完"和"伪成功包"，那才是真正影响可用性的两种状态。
async function probeChat(env, rec) {
  const { sendChatTurn } = await import("./upstream.js");
  const token = await login(env, { sn: rec.sn, secret: rec.secret });
  const common = {
    token,
    sn: rec.sn,
    buildNum: "163",
    buildTime: "2512151629",
    versionName: "4.3.14",
    versionCode: "4030014",
    appName: "com.zuoyebang.iot.pad.zpvoiceassistant",
    romVersion: "4.3.0",
    local: "zh-CN",
    __tips__: "1",
  };
  const res = await sendChatTurn(env, common, rec.secret, {
    chatId: `probe-${rec.sn.slice(-8)}-${Date.now()}`,
    content: "1+1",
    model: "deepseek-v3",
    role: "user",
    kind: "8",
  });
  const text = await res.text();
  if (/今日次数已用完|次数已用完/.test(text)) return { state: "quota" };
  if (/"message"\s*:\s*"success"/.test(text) && text.includes("event: error")) return { state: "limited" };
  if (text.includes("cid or passportId")) return { state: "unbound" };
  if (text.includes("event: message")) return { state: "ok" };
  return { state: "unknown", raw: text.slice(0, 200) };
}

export async function checkCredential(env, sn, { chat = true } = {}) {
  const rec = await getCredential(env, sn);
  if (!rec) return { sn, ok: false, error: "not found" };
  const started = Date.now();
  try {
    const info = await loginDetailed(env, { sn: rec.sn, secret: rec.secret });
    rec.binded = info.binded ? 1 : 0;
    rec.catbinded = info.catbinded || 0;
    rec.halted = info.halted || 0;
    rec.deviceId = info.deviceId || 0;
    rec.status = "active";
    rec.lastCheck = Date.now();
    rec.lastOkAt = rec.lastCheck;
    rec.failWindow = [];
    rec.lastError = "";
    rec.cooldownUntil = 0;
    rec.okCount = (rec.okCount || 0) + 1;
    await putCredential(env, rec);

    // 登录成功不代表能回答：再做一次真实对话探测限流/额度
    if (chat && rec.binded === 1) {
      const p = await probeChat(env, rec);
      const now = Date.now();
      rec.lastCheck = now;
      if (p.state === "ok") {
        rec.lastOkAt = now;
        rec.failWindow = [];
        rec.lastError = "";
        rec.cooldownUntil = 0;
        rec.quotaExhaustedAt = 0;
      } else if (p.state === "quota") {
        rec.quotaExhaustedAt = now;
        rec.cooldownUntil = nextMidnight();
        rec.lastError = "今日次数已用完（探测）";
        rec.failWindow = [...(rec.failWindow || []), now];
      } else if (p.state === "limited") {
        rec.cooldownUntil = now + 60 * 1000;
        rec.lastError = "限流（伪成功包）";
        rec.failWindow = [...(rec.failWindow || []), now];
      } else if (p.state === "unbound") {
        rec.binded = 0;
        rec.lastError = "未绑定账号";
      } else {
        rec.lastError = "对话探测异常：" + String(p.raw || "").slice(0, 80);
      }
      await putCredential(env, rec);
      return { sn, ok: p.state === "ok", state: p.state, ms: Date.now() - started, binded: rec.binded };
    }

    return { sn, ok: true, ms: Date.now() - started, binded: rec.binded };
  } catch (e) {
    const msg = String(e.message || e);
    // "设备Secret获取失败" means the secret no longer matches the device.
    const dead = /Secret获取失败|invalid.secret|secret/i.test(msg) && !/HTTP|timeout/i.test(msg);
    rec.status = dead ? "dead" : rec.status === "dead" ? "active" : rec.status || "active";
    rec.lastCheck = Date.now();
    rec.lastError = msg.slice(0, 200);
    rec.lastErrorAt = rec.lastCheck;
    rec.failWindow = [...(rec.failWindow || []).filter((t) => rec.lastCheck - t < FAIL_WINDOW_MS), rec.lastCheck];
    if (dead) rec.cooldownUntil = 0;
    rec.failCount = (rec.failCount || 0) + 1;
    await putCredential(env, rec);
    return { sn, ok: false, error: msg, dead };
  }
}

// Derive the *real* state shown in the admin panel. `status` alone is a config
// flag; this combines it with cooldown and the recent failure window.
export function healthOf(rec, now = Date.now()) {
  if (!rec) return { key: "unknown", label: "未知", detail: "" };
  if (rec.status === "disabled") return { key: "disabled", label: "已禁用", detail: "手动禁用，不参与轮换" };
  if (rec.status === "dead") return { key: "dead", label: "失效", detail: rec.lastError || "登录被拒绝，需要更新 secret" };
  if (rec.halted) return { key: "halted", label: "已停机", detail: "上游标记 halted=1，需重新激活" };
  if (rec.binded === 0) {
    return { key: "unbound", label: "未绑定", detail: "能登录但未绑定账号，回答会报 cid/passportId=0" };
  }
  if (rec.quotaExhaustedAt && rec.cooldownUntil && now < rec.cooldownUntil) {
    return {
      key: "quota",
      label: "额度耗尽",
      detail: "今日次数用完，约 " + Math.max(1, Math.ceil((rec.cooldownUntil - now) / 3600000)) + " 小时后恢复",
    };
  }
  if (rec.cooldownUntil && now < rec.cooldownUntil) {
    return { key: "cooling", label: "冷却中", detail: "剩余 " + Math.ceil((rec.cooldownUntil - now) / 1000) + " 秒" };
  }
  const recent = (rec.failWindow || []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (recent.length >= 2) {
    return { key: "flaky", label: "疑似限流", detail: "近 5 分钟失败 " + recent.length + " 次：" + (rec.lastError || "") };
  }
  if (rec.lastOkAt) {
    const ago = Math.round((now - rec.lastOkAt) / 1000);
    return { key: "ok", label: "可用", detail: "最近成功 " + (ago < 60 ? ago + " 秒前" : ago < 3600 ? Math.round(ago / 60) + " 分钟前" : Math.round(ago / 3600) + " 小时前") };
  }
  return { key: "unknown", label: "未验证", detail: "尚未成功调用过，建议点「检测」" };
}

// 把 binded=0 的设备批量禁用，避免轮换时被选中。
export async function disableUnbound(env) {
  const all = await listCredentials(env);
  const hit = [];
  for (const rec of all) {
    if (rec.binded === 0 && rec.status !== "disabled") {
      rec.status = "disabled";
      rec.lastError = "未绑定账号（binded=0），已自动禁用";
      rec.updatedAt = Date.now();
      await putCredential(env, rec);
      hit.push(rec.sn);
    }
  }
  return hit;
}

// 分页检测：从 cursor 开始最多测 limit 台，返回 nextCursor（null 表示测完）。
export async function checkAll(env, { limit = 20, cursor = 0 } = {}) {
  const all = await listCredentials(env);
  const total = all.length;
  const start = Math.max(0, Number(cursor) || 0);
  const slice = all.slice(start, start + limit);
  const results = [];
  for (const rec of slice) {
    results.push(await checkCredential(env, rec.sn));
  }
  const next = start + slice.length;
  return { results, total, done: next >= total, nextCursor: next >= total ? null : next };
}
