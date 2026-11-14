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

const RECENT_KEY = "log:recent";
const RECENT_MAX = 100;
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
    const recent = (await getJSON(env, RECENT_KEY, [])) || [];
    recent.unshift(record);
    await putJSON(env, RECENT_KEY, recent.slice(0, RECENT_MAX), RECENT_TTL);
  } catch (err) {
    console.error("[log] persist failed: " + (err && err.message ? err.message : err));
  }
  return record;
}

export async function listRecentLogs(env, limit = 50) {
  const recent = (await getJSON(env, RECENT_KEY, [])) || [];
  return recent.slice(0, Math.max(1, Math.min(limit, RECENT_MAX)));
}

export async function clearRecentLogs(env) {
  await putJSON(env, RECENT_KEY, [], RECENT_TTL);
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
