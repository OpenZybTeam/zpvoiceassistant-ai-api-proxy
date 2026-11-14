// API token management (sk-...).
//
// A token record:
//   {
//     id:        "tok_<hash-prefix>"   // stable, derived from the secret
//     token:     "sk-...."             // plaintext, shown in the admin panel
//     hash:      sha256 hex            // index key (lookup stays O(1))
//     prefix:    "sk-abcd..."           // first 12 chars, for identification in UI
//     note:      "给小王测试用"
//     createdAt: 1731600000000
//     expiresAt: 0 | ms                 // 定时过期
//     maxUses:   0 | number             // 按次数过期（请求时检测）
//     uses:      0
//     enabled:   true
//   }
//
// Verification happens on every request: hash the presented key, look the record
// up, then check enabled / expiry / quota. The counter is read-modify-write;
// low traffic makes that acceptable.

import {
  del,
  getJSON,
  indexAdd,
  indexList,
  indexRemove,
  putJSON,
  PREFIX,
} from "./store.js";

export const TOKEN_PREFIX_TEXT = "sk-";

function hex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return hex(new Uint8Array(buf));
}

// Constant-time-ish compare for fixed-length hex strings.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function tokenKey(hash) {
  return PREFIX.TOKEN + hash;
}

export function newTokenText() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX_TEXT + Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

export async function createToken(env, { note = "", expiresAt = 0, maxUses = 0, token } = {}) {
  const text = token && String(token).startsWith(TOKEN_PREFIX_TEXT) ? String(token) : newTokenText();
  const hash = await sha256Hex(text);
  const record = {
    id: `tok_${hash.slice(0, 12)}`,
    hash,
    token: text,
    prefix: text.slice(0, 12) + "…",
    note: String(note || "").slice(0, 200),
    createdAt: Date.now(),
    expiresAt: Number(expiresAt) || 0,
    maxUses: Number(maxUses) || 0,
    uses: 0,
    enabled: true,
  };
  await putJSON(env, tokenKey(hash), record, 0);
  await indexAdd(env, PREFIX.TOKEN_IDX, hash);
  return { token: text, record };
}

export async function listTokens(env) {
  const hashes = await indexList(env, PREFIX.TOKEN_IDX);
  const out = [];
  for (const h of hashes) {
    const rec = await getJSON(env, tokenKey(h), null);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

// Regenerate the secret of an existing token (keeps note/quota/expiry).
// Old records (created before plaintext storage) have no `token` field; they can
// still be verified but the key cannot be recovered — rotate to get a new one.
export async function migrateLegacyTokens(env) {
  const hashes = await indexList(env, PREFIX.TOKEN_IDX);
  let migrated = 0;
  for (const h of hashes) {
    const rec = await getJSON(env, tokenKey(h), null);
    if (rec && !rec.token) {
      rec.token = "";
      rec.legacy = true;
      await putJSON(env, tokenKey(h), rec, 0);
      migrated++;
    }
  }
  return migrated;
}

export async function rotateToken(env, hash) {
  const rec = await getJSON(env, tokenKey(hash), null);
  if (!rec) return null;
  const text = newTokenText();
  const newHash = await sha256Hex(text);
  const next = { ...rec, hash: newHash, token: text, prefix: text.slice(0, 12) + "…" };
  await putJSON(env, tokenKey(newHash), next, 0);
  await indexRemove(env, PREFIX.TOKEN_IDX, hash);
  await indexAdd(env, PREFIX.TOKEN_IDX, newHash);
  await del(env, tokenKey(hash));
  return next;
}

export async function updateToken(env, hash, patch) {
  const rec = await getJSON(env, tokenKey(hash), null);
  if (!rec) return null;
  const next = { ...rec };
  if (patch.note !== undefined) next.note = String(patch.note).slice(0, 200);
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.expiresAt !== undefined) next.expiresAt = Number(patch.expiresAt) || 0;
  if (patch.maxUses !== undefined) next.maxUses = Number(patch.maxUses) || 0;
  await putJSON(env, tokenKey(hash), next, 0);
  return next;
}

export async function deleteToken(env, hash) {
  await del(env, tokenKey(hash));
  await indexRemove(env, PREFIX.TOKEN_IDX, hash);
  await del(env, PREFIX.USAGE_TOK + hash);
}

// Resolve a presented key to { record } or { error }.
// Errors: invalid_key / token_disabled / token_expired / token_exhausted
export async function verifyToken(env, presented) {
  const key = String(presented || "").trim();
  if (!key) return { error: "invalid_key" };
  const hash = await sha256Hex(key);
  const rec = await getJSON(env, tokenKey(hash), null);
  if (!rec) return { error: "invalid_key" };
  // Guard against hash collisions / tampering in the index.
  if (rec.hash && !safeEqual(rec.hash, hash)) return { error: "invalid_key" };
  if (rec.enabled === false) return { error: "token_disabled", record: rec };
  if (rec.expiresAt && Date.now() >= rec.expiresAt) return { error: "token_expired", record: rec };
  if (rec.maxUses && (rec.uses || 0) >= rec.maxUses) return { error: "token_exhausted", record: rec };
  return { record: rec };
}

// Count one successful request against the token, enforcing per-use quota.
export async function consumeToken(env, rec) {
  if (!rec) return null;
  const next = { ...rec, uses: (rec.uses || 0) + 1, lastUsed: Date.now() };
  await putJSON(env, tokenKey(rec.hash), next, 0);
  return next;
}

export { safeEqual };
