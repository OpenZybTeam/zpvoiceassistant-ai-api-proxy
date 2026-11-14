// Storage layer.
//
// Everything that used to be hard-coded now lives in KV under a single binding
// (env.HISTORY, reused as general-purpose storage so no new namespace is
// required). If KV is unavailable the worker still runs, but the admin page is
// disabled and the credential pool is empty — there is no built-in fallback pool
// any more, by design.
//
// Key layout:
//   cfg:admin                 { passwordHash, salt, createdAt, updatedAt }
//   tok:<hash>                API token record   (see token.js)
//   tok:idx                   JSON array of token hashes (for listing)
//   sn:<sn>                   device credential record (see snpool.js)
//   sn:idx                    JSON array of sn strings
//   usage:tok:<hash>          { requests, prompt_tokens, completion_tokens, lastUsed }
//   usage:sn:<sn>             same shape, per device
//   usage:day:<yyyymmdd>      global counters for the dashboard
//
// KV has no atomic increment, so counters are read-modify-write. Traffic on this
// proxy is low enough that this is fine; the admin page shows approximate values.

const PREFIX = {
  CORE: "cfg:",
  TOKEN: "tok:",
  TOKEN_IDX: "tok:idx",
  SN: "sn:",
  SN_IDX: "sn:idx",
  USAGE_TOK: "usage:tok:",
  USAGE_SN: "usage:sn:",
  USAGE_DAY: "usage:day:",
};

// One year: these records outlive any reasonable deployment.
const TTL = 60 * 60 * 24 * 365;

export function kv(env) {
  const store = env && env.HISTORY;
  if (!store) throw new Error("KV binding HISTORY is not configured");
  return store;
}

export function hasKV(env) {
  return !!(env && env.HISTORY);
}

export async function getJSON(env, key, fallback = null) {
  if (!hasKV(env)) return fallback;
  try {
    const v = await kv(env).get(key, "json");
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export async function putJSON(env, key, value, ttl = TTL) {
  await kv(env).put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : {});
}

export async function del(env, key) {
  if (!hasKV(env)) return;
  try {
    await kv(env).delete(key);
  } catch {
    // best-effort
  }
}

// ---- index lists -----------------------------------------------------------

async function readIndex(env, key) {
  const v = await getJSON(env, key, []);
  return Array.isArray(v) ? v : [];
}

async function writeIndex(env, key, list) {
  await putJSON(env, key, list);
}

export async function indexAdd(env, key, id) {
  const list = await readIndex(env, key);
  if (!list.includes(id)) {
    list.push(id);
    await writeIndex(env, key, list);
  }
}

export async function indexRemove(env, key, id) {
  const list = await readIndex(env, key);
  const next = list.filter((x) => x !== id);
  if (next.length !== list.length) await writeIndex(env, key, next);
}

export async function indexList(env, key) {
  return readIndex(env, key);
}

// ---- admin config ----------------------------------------------------------

export async function getAdminConfig(env) {
  return getJSON(env, PREFIX.CORE + "admin", null);
}

export async function setAdminConfig(env, cfg) {
  await putJSON(env, PREFIX.CORE + "admin", cfg, 0);
}

// ---- counters --------------------------------------------------------------

function emptyUsage() {
  return { requests: 0, prompt_tokens: 0, completion_tokens: 0, lastUsed: 0 };
}

export async function getUsageRecord(env, kind, id) {
  const key = (kind === "sn" ? PREFIX.USAGE_SN : PREFIX.USAGE_TOK) + id;
  const v = await getJSON(env, key, null);
  return v && typeof v === "object" ? { ...emptyUsage(), ...v } : emptyUsage();
}

export async function bumpUsage(env, kind, id, delta) {
  if (!id || !delta) return;
  const key = (kind === "sn" ? PREFIX.USAGE_SN : PREFIX.USAGE_TOK) + id;
  const cur = await getUsageRecord(env, kind, id);
  const next = {
    requests: cur.requests + 1,
    prompt_tokens: cur.prompt_tokens + (delta.prompt_tokens || 0),
    completion_tokens: cur.completion_tokens + (delta.completion_tokens || 0),
    lastUsed: Date.now(),
  };
  await putJSON(env, key, next);
  return next;
}

export async function bumpDayUsage(env, delta) {
  const d = new Date();
  const key = PREFIX.USAGE_DAY + `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const cur = await getJSON(env, key, { requests: 0, prompt_tokens: 0, completion_tokens: 0 });
  await putJSON(
    env,
    key,
    {
      requests: (cur.requests || 0) + 1,
      prompt_tokens: (cur.prompt_tokens || 0) + (delta.prompt_tokens || 0),
      completion_tokens: (cur.completion_tokens || 0) + (delta.completion_tokens || 0),
    },
    60 * 60 * 24 * 120
  );
}

// 单次请求的用量记账：把 sn / token / 当日三条计数合并成一批写入，
// 减少 KV 往返。仍非原子，但足够统计用。
export async function recordRequestUsage(env, sn, tokenHash, delta = {}) {
  if (!hasKV(env)) return;
  const p = delta.prompt_tokens || 0;
  const c = delta.completion_tokens || 0;
  const now = Date.now();
  const d = new Date(now);
  const dayKey =
    PREFIX.USAGE_DAY +
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

  const bump = (cur) => ({
    requests: (cur?.requests || 0) + 1,
    prompt_tokens: (cur?.prompt_tokens || 0) + p,
    completion_tokens: (cur?.completion_tokens || 0) + c,
    lastUsed: now,
  });

  const writes = [];
  if (sn) {
    const k = PREFIX.USAGE_SN + sn;
    writes.push(getJSON(env, k, null).then((cur) => putJSON(env, k, bump(cur))));
  }
  if (tokenHash) {
    const k = PREFIX.USAGE_TOK + tokenHash;
    writes.push(getJSON(env, k, null).then((cur) => putJSON(env, k, bump(cur))));
  }
  const dayCur = await getJSON(env, dayKey, { requests: 0, prompt_tokens: 0, completion_tokens: 0 });
  writes.push(
    putJSON(
      env,
      dayKey,
      {
        requests: (dayCur.requests || 0) + 1,
        prompt_tokens: (dayCur.prompt_tokens || 0) + p,
        completion_tokens: (dayCur.completion_tokens || 0) + c,
      },
      60 * 60 * 24 * 120
    )
  );
  await Promise.all(writes);
}

export { PREFIX };
