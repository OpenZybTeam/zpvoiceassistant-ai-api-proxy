// Admin auth.
//
// First visit to /admin sets the password (stored as PBKDF2-SHA256 with a random
// salt in KV). Login issues a signed session cookie:
//   session = base64url(payload) + "." + base64url(hmacSHA256(payload, key))
// where key = sha256(stored password hash). The cookie is HttpOnly, SameSite=Lax
// and expires after SESSION_TTL.

import { getAdminConfig, setAdminConfig } from "./store.js";
import { safeEqual } from "./token.js";

export const SESSION_COOKIE = "iot_admin";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const PBKDF2_ITERATIONS = 100000;

function b64url(bytes) {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return hex(bits);
}

function randomSalt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return hex(b);
}

export async function isInitialized(env) {
  const cfg = await getAdminConfig(env);
  return !!(cfg && cfg.passwordHash && cfg.salt);
}

export async function setupPassword(env, password) {
  const cfg = await getAdminConfig(env);
  if (cfg && cfg.passwordHash) return { ok: false, error: "already_initialized" };
  if (typeof password !== "string" || password.length < 6) {
    return { ok: false, error: "password_too_short" };
  }
  const salt = randomSalt();
  const now = Date.now();
  await setAdminConfig(env, {
    passwordHash: await hashPassword(password, salt),
    salt,
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true };
}

export async function changePassword(env, oldPassword, newPassword) {
  const cfg = await getAdminConfig(env);
  if (!cfg) return { ok: false, error: "not_initialized" };
  if (!(await verifyPassword(env, oldPassword))) return { ok: false, error: "wrong_password" };
  if (typeof newPassword !== "string" || newPassword.length < 6) return { ok: false, error: "password_too_short" };
  const salt = randomSalt();
  await setAdminConfig(env, {
    ...cfg,
    passwordHash: await hashPassword(newPassword, salt),
    salt,
    updatedAt: Date.now(),
  });
  return { ok: true };
}

export async function verifyPassword(env, password) {
  const cfg = await getAdminConfig(env);
  if (!cfg || !cfg.passwordHash || !cfg.salt) return false;
  const got = await hashPassword(password, cfg.salt);
  return safeEqual(got, cfg.passwordHash);
}

async function signingKey(env) {
  const cfg = await getAdminConfig(env);
  if (!cfg) throw new Error("admin not initialized");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(cfg.passwordHash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function issueSession(env) {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_MS });
  const body = b64url(new TextEncoder().encode(payload));
  const key = await signingKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifySession(env, cookieValue) {
  if (!cookieValue || typeof cookieValue !== "string" || !cookieValue.includes(".")) return false;
  const [body, sig] = cookieValue.split(".");
  try {
    const key = await signingKey(env);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      fromB64url(sig),
      new TextEncoder().encode(body)
    );
    if (!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return typeof payload.exp === "number" && payload.exp > Date.now();
  } catch {
    return false;
  }
}

export function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return "";
}

export function sessionCookie(value, maxAgeMs = SESSION_TTL_MS) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function requireAdmin(env, request) {
  if (!(await isInitialized(env))) return { ok: false, reason: "not_initialized" };
  const cookie = readCookie(request, SESSION_COOKIE);
  const ok = await verifySession(env, cookie);
  return ok ? { ok: true } : { ok: false, reason: "unauthenticated" };
}
