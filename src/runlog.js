// Request logging.
//
// 每次请求生成一条带 requestId 的 run log：
//   - 阶段打点（auth / pool / upstream / parse / done / error）
//   - 每个阶段耗时（ms）
//   - 设备、令牌、模型、模式
//   - 重试与退避记录
//
// 输出到 console（wrangler tail 可见），同时把最近若干条保存在 KV 里
// （log:recent，环形缓冲），后台「日志」页可直接查，不用盯终端。
//
// 设计目标：出问题时能回答"卡在哪一步、卡了多久、试了几台设备"。

import { getJSON, hasKV, putJSON } from "./store.js";

// 每条日志独立存一个 key：log:<ts>:<id>。
// 早期用单个数组 log:recent，并发请求会读改写互相覆盖导致日志丢失。
const LOG_PREFIX = "log:";
const RECENT_MAX = 200;
const RECENT_TTL = 60 * 60 * 24 * 7;

// 一次请求的最大允许耗时。超过就主动中断并返回明确错误，
// 而不是让调用方（agent 平台）干等到自己超时。
export const REQUEST_DEADLINE_MS = Number(globalThis.__DEADLINE_MS__) || 60000;

export function newRequestId() {
  return "req_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

class RunLog {
  constructor(requestId, meta = {}) {
    this.id = requestId;
    this.start = Date.now();
    this.last = this.start;
    this.steps = [];
    this.meta = meta;
    this.retries = [];
    this.status = "running";
    this.error = null;
  }

  // 记录一个阶段；返回本阶段耗时
  step(name, extra = {}) {
    const now = Date.now();
    const entry = {
      name,
      at: now - this.start,
      ms: now - this.last,
      ...extra,
    };
    this.steps.push(entry);
    this.last = now;
    return entry.ms;
  }

  retry(info) {
    this.retries.push({ at: Date.now() - this.start, ...info });
  }

  finish(status, error = null, extra = {}) {
    this.status = status;
    this.error = error ? String(error).slice(0, 500) : null;
    const now = Date.now();
    this.totalMs = now - this.start;
    const record = {
      id: this.id,
      status,
      error: this.error,
      totalMs: this.totalMs,
      startedAt: this.start,
      ...this.meta,
      ...extra,
      steps: this.steps,
      retries: this.retries,
    };
    return record;
  }
}

export function startRun(meta) {
  return new RunLog(newRequestId(), meta);
}

// 把耗时超阈值的请求标红输出；正常请求只打一行摘要。
function summary(record) {
  const chain = record.steps.map((s) => `${s.name}:${s.ms}ms`).join(" → ");
  return `[${record.id}] ${record.status} ${record.totalMs}ms ${record.model || ""} ${record.sn || ""} ${record.token || ""} | ${chain}`;
}

export async function commitRun(env, record) {
  const line = summary(record);
  if (record.status === "error") {
    console.error(line + " | " + (record.error || ""));
    if (record.retries.length) console.error("  retries: " + JSON.stringify(record.retries).slice(0, 500));
  } else if (record.totalMs > 20000) {
    console.warn(line + " | SLOW");
  } else {
    console.log(line);
  }

  if (!hasKV(env)) return record;
  try {
    // 时间戳放在 key 里，按字典序倒排即为时间倒序
    const key = `${LOG_PREFIX}${String(record.startedAt).padStart(15, "0")}:${record.id}`;
    await putJSON(env, key, record, RECENT_TTL);
    // 顺手清理超出上限的旧日志（异步，失败不影响主流程）
    pruneOld(env).catch(() => {});
  } catch (err) {
    console.error("[log] persist failed: " + (err && err.message ? err.message : err));
  }
  return record;
}

// 保留最近 RECENT_MAX 条，删除更早的
async function pruneOld(env) {
  if (!hasKV(env)) return 0;
  const store = env.HISTORY;
  try {
    const listed = await store.list({ prefix: LOG_PREFIX, limit: 1000 });
    const keys = listed.keys.map((k) => k.name).sort();
    if (keys.length <= RECENT_MAX) return 0;
    const drop = keys.slice(0, keys.length - RECENT_MAX);
    for (const k of drop) {
      try { await store.delete(k); } catch {}
    }
    return drop.length;
  } catch {
    return 0;
  }
}

export async function listRecentLogs(env, limit = 50) {
  if (!hasKV(env)) return [];
  const n = Math.max(1, Math.min(limit, RECENT_MAX));
  try {
    const listed = await env.HISTORY.list({ prefix: LOG_PREFIX, limit: 1000 });
    const keys = listed.keys.map((k) => k.name).sort().reverse().slice(0, n);
    const out = [];
    for (const k of keys) {
      const rec = await getJSON(env, k, null);
      if (rec) out.push(rec);
    }
    return out;
  } catch (err) {
    console.error("[log] list failed: " + (err && err.message ? err.message : err));
    return [];
  }
}

export async function clearRecentLogs(env) {
  if (!hasKV(env)) return 0;
  try {
    const listed = await env.HISTORY.list({ prefix: LOG_PREFIX, limit: 1000 });
    for (const k of listed.keys) {
      try { await env.HISTORY.delete(k.name); } catch {}
    }
    return listed.keys.length;
  } catch {
    return 0;
  }
}

// 给任意 Promise 加超时，超时后 reject 一个带 code 的 Error。
export function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} timed out after ${ms}ms`);
      e.code = "timeout";
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
