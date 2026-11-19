// Admin API + page.
//
// Routes (all under /admin):
//   GET  /admin                     -> HTML page (setup or login or dashboard)
//   POST /admin/api/setup           { password }            first-run only
//   POST /admin/api/login           { password }            sets session cookie
//   POST /admin/api/logout
//   POST /admin/api/password        { oldPassword, newPassword }
//   GET  /admin/api/overview        -> { tokens, sns, usage, dayUsage }
//   GET  /admin/api/tokens?q=       -> list (note search)
//   POST /admin/api/tokens          { note, expiresAt, maxUses }  -> { token }
//   PATCH /admin/api/tokens         { hash, note?, enabled?, expiresAt?, maxUses? }
//   DELETE /admin/api/tokens        { hash }
//   GET  /admin/api/sns?q=          -> list
//   POST /admin/api/sns             { sn, secret, note }
//   POST /admin/api/sns/import      { text }                one pair per line
//   PATCH /admin/api/sns            { sn, note?, status? }
//   DELETE /admin/api/sns           { sn } | { sns: [...] } batch
//   POST /admin/api/sns/check       { sn } | { all: true }  availability probe

import { corsFor } from "./cors.js";
import {
  changePassword,
  clearCookie,
  isInitialized,
  issueSession,
  readCookie,
  requireAdmin,
  sessionCookie,
  setupPassword,
  verifyPassword,
} from "./auth.js";
import { getJSON, PREFIX } from "./store.js";
import {
  consumeToken,
  createToken,
  deleteToken,
  listTokens,
  migrateLegacyTokens,
  rotateToken,
  updateToken,
  verifyToken,
} from "./token.js";
import {
  addCredential,
  checkAll,
  checkCredential,
  deleteCredential,
  importCredentials,
  listCredentials,
  putCredential,
  getCredential,
  healthOf,
  disableUnbound,
} from "./snpool.js";
import { renderAdmin } from "./admin-ui.js";
import { clearRecentLogs, listRecentLogs } from "./runlog.js";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function tokenUsage(env, hash) {
  return getJSON(env, PREFIX.USAGE_TOK + hash, { requests: 0, prompt_tokens: 0, completion_tokens: 0, lastUsed: 0 });
}

async function snUsage(env, sn) {
  return getJSON(env, PREFIX.USAGE_SN + sn, { requests: 0, prompt_tokens: 0, completion_tokens: 0, lastUsed: 0 });
}

export async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Page shell (auth state rendered client-side).
  if (path === "/admin" && method === "GET") {
    return html(renderAdmin(await isInitialized(env)));
  }

  if (path === "/admin/api/setup" && method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body.password !== "string") return json({ error: "bad_request" }, 400);
    const r = await setupPassword(env, body.password);
    if (!r.ok) return json({ error: r.error }, 400);
    const session = await issueSession(env);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(session) });
  }

  if (path === "/admin/api/login" && method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body.password !== "string") return json({ error: "bad_request" }, 400);
    if (!(await verifyPassword(env, body.password))) return json({ error: "wrong_password" }, 401);
    const session = await issueSession(env);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(session) });
  }

  if (path === "/admin/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  // Everything below requires a session.
  const gate = await requireAdmin(env, request);
  if (!gate.ok) {
    return json({ error: gate.reason }, gate.reason === "not_initialized" ? 409 : 401);
  }

  if (path === "/admin/api/session" && method === "GET") {
    return json({ ok: true });
  }

  if (path === "/admin/api/password" && method === "POST") {
    const body = await readJson(request) || {};
    const r = await changePassword(env, body.oldPassword, body.newPassword);
    if (!r.ok) return json({ error: r.error }, 400);
    const session = await issueSession(env);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(session) });
  }

  if (path === "/admin/api/logs" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") || 50);
    const logs = await listRecentLogs(env, limit);
    return json({ ok: true, logs });
  }

  if (path === "/admin/api/logs" && method === "DELETE") {
    await clearRecentLogs(env);
    return json({ ok: true });
  }

  if (path === "/admin/api/migrate" && method === "POST") {
    const n = await migrateLegacyTokens(env);
    return json({ ok: true, migrated: n });
  }

  if (path === "/admin/api/overview" && method === "GET") {
    const tokens = await listTokens(env);
    const sns = await listCredentials(env);
    let tokenUsageTotal = { requests: 0, prompt_tokens: 0, completion_tokens: 0 };
    let snUsageTotal = { requests: 0, prompt_tokens: 0, completion_tokens: 0 };
    const tokenRows = [];
    for (const t of tokens) {
      const u = await tokenUsage(env, t.hash);
      tokenRows.push({ ...t, usage: u });
      tokenUsageTotal.requests += u.requests || 0;
      tokenUsageTotal.prompt_tokens += u.prompt_tokens || 0;
      tokenUsageTotal.completion_tokens += u.completion_tokens || 0;
    }
    const snRows = [];
    for (const s of sns) {
      const u = await snUsage(env, s.sn);
      snRows.push({ ...s, usage: u, health: healthOf(s) });
      snUsageTotal.requests += u.requests || 0;
      snUsageTotal.prompt_tokens += u.prompt_tokens || 0;
      snUsageTotal.completion_tokens += u.completion_tokens || 0;
    }
    return json({
      ok: true,
      tokens: tokenRows,
      sns: snRows,
      tokenUsage: tokenUsageTotal,
      snUsage: snUsageTotal,
      counts: {
        tokens: tokens.length,
        tokensActive: tokens.filter((t) => t.enabled !== false).length,
        sns: sns.length,
        snsUsable: sns.filter((s) => healthOf(s).key === "ok").length,
        snsHealthy: sns.filter((s) => ["ok", "unknown"].includes(healthOf(s).key)).length,
        snsFlaky: sns.filter((s) => healthOf(s).key === "flaky").length,
        snsCooling: sns.filter((s) => healthOf(s).key === "cooling").length,
        snsQuota: sns.filter((s) => healthOf(s).key === "quota").length,
        snsDead: sns.filter((s) => ["dead", "disabled"].includes(healthOf(s).key)).length,
        snsUnbound: sns.filter((s) => healthOf(s).key === "unbound").length,
        snsHalted: sns.filter((s) => healthOf(s).key === "halted").length,
      },
    });
  }

  // ---- tokens -------------------------------------------------------------
  if (path === "/admin/api/tokens" && method === "GET") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    let rows = await listTokens(env);
    if (q) rows = rows.filter((t) => (t.note || "").toLowerCase().includes(q) || t.prefix.includes(q));
    return json({ ok: true, tokens: rows });
  }

  if (path === "/admin/api/tokens" && method === "POST") {
    const body = await readJson(request) || {};
    const { token, record } = await createToken(env, {
      note: body.note,
      expiresAt: body.expiresAt,
      maxUses: body.maxUses,
    });
    return json({ ok: true, token, record });
  }

  if (path === "/admin/api/tokens" && method === "PATCH") {
    const body = await readJson(request) || {};
    if (!body.hash) return json({ error: "hash_required" }, 400);
    const rec = await updateToken(env, body.hash, body);
    return rec ? json({ ok: true, record: rec }) : json({ error: "not_found" }, 404);
  }

  if (path === "/admin/api/tokens/rotate" && method === "POST") {
    const body = await readJson(request) || {};
    if (!body.hash) return json({ error: "hash_required" }, 400);
    const rec = await rotateToken(env, body.hash);
    return rec ? json({ ok: true, record: rec }) : json({ error: "not_found" }, 404);
  }

  if (path === "/admin/api/tokens" && method === "DELETE") {
    const body = await readJson(request) || {};
    const list = Array.isArray(body.hashes) ? body.hashes : body.hash ? [body.hash] : [];
    if (list.length === 0) return json({ error: "hash_required" }, 400);
    let n = 0;
    for (const h of list) {
      await deleteToken(env, String(h));
      n++;
    }
    return json({ ok: true, deleted: n });
  }

  // ---- sn pool ------------------------------------------------------------
  if (path === "/admin/api/sns" && method === "GET") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    let rows = await listCredentials(env);
    if (q) rows = rows.filter((r) => r.sn.includes(q) || (r.note || "").toLowerCase().includes(q));
    const out = [];
    for (const r of rows) {
      out.push({ ...r, usage: await snUsage(env, r.sn), health: healthOf(r) });
    }
    return json({ ok: true, sns: out });
  }

  if (path === "/admin/api/sns" && method === "POST") {
    const body = await readJson(request) || {};
    if (!body.sn || !body.secret) return json({ error: "sn_and_secret_required" }, 400);
    try {
      const rec = await addCredential(env, {
        sn: String(body.sn).trim(),
        secret: String(body.secret).trim(),
        note: body.note,
      });
      return json({ ok: true, sn: rec });
    } catch (e) {
      if (e.code === "duplicate_sn") {
        return json({ error: "duplicate_sn", message: e.message }, 409);
      }
      return json({ error: "add_failed", message: e.message }, 400);
    }
  }

  // 导出：?format=txt（默认，一行一对）或 ?format=json（含状态与备注）
  if (path === "/admin/api/sns/export" && method === "GET") {
    const format = (url.searchParams.get("format") || "txt").toLowerCase();
    const all = await listCredentials(env);
    if (format === "json") {
      return json({
        ok: true,
        exportedAt: Date.now(),
        count: all.length,
        sns: all.map((r) => ({
          sn: r.sn,
          secret: r.secret,
          note: r.note || "",
          status: r.status || "active",
        })),
      });
    }
    const lines = all.map((r) => [r.sn, r.secret, r.note || ""].filter(Boolean).join(" "));
    const body = lines.join("\n") + (lines.length ? "\n" : "");
    return new Response(body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="sn-secret-${new Date().toISOString().slice(0, 10)}.txt"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (path === "/admin/api/sns/import" && method === "POST") {
    const body = await readJson(request) || {};
    // text 为纯文本行；fileContent 为上传文件的原文（同样是文本行）
    const raw = typeof body.text === "string" ? body.text : typeof body.fileContent === "string" ? body.fileContent : null;
    if (raw === null) return json({ error: "text_required" }, 400);
    // 按字节算上限（中文备注一个字符可能 3 字节）；上限 15 MB
    const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
    if (new TextEncoder().encode(raw).length > MAX_IMPORT_BYTES) {
      return json({ error: "file_too_large", message: "文件不得超过 15 MB" }, 413);
    }
    const r = await importCredentials(env, raw);
    return json({ ok: true, ...r });
  }

  if (path === "/admin/api/sns" && method === "PATCH") {
    const body = await readJson(request) || {};
    if (!body.sn) return json({ error: "sn_required" }, 400);
    const rec = await getCredential(env, body.sn);
    if (!rec) return json({ error: "not_found" }, 404);
    if (body.note !== undefined) rec.note = String(body.note).slice(0, 200);
    if (body.status !== undefined && ["active", "disabled", "dead"].includes(body.status)) {
      rec.status = body.status;
      // 手动恢复为 active/ dead 时，清掉冷却与失败窗口，其余运行记录保留
      if (body.status === "active") {
        rec.cooldownUntil = 0;
        rec.failWindow = [];
        rec.lastError = "";
      }
    }
    // 显式要求时才会清冷却
    if (body.clearCooldown) {
      rec.cooldownUntil = 0;
      rec.failWindow = [];
      rec.lastError = "";
    }
    if (body.secret) rec.secret = String(body.secret).trim();
    rec.updatedAt = Date.now();
    await putCredential(env, rec);
    return json({ ok: true, sn: rec });
  }

  if (path === "/admin/api/sns/bulk" && method === "POST") {
    const body = await readJson(request) || {};
    const list = Array.isArray(body.sns) ? body.sns : [];
    const status = body.status;
    if (!list.length) return json({ error: "sns_required" }, 400);
    if (!["active", "disabled", "dead"].includes(status)) return json({ error: "bad_status" }, 400);
    for (const sn of list) {
      const rec = await getCredential(env, String(sn));
      if (!rec) continue;
      rec.status = status;
      if (status === "active" || status === "dead") {
        rec.cooldownUntil = 0;
        rec.failWindow = [];
        rec.lastError = "";
      }
      rec.updatedAt = Date.now();
      await putCredential(env, rec);
    }
    return json({ ok: true, updated: list.length });
  }

  if (path === "/admin/api/sns" && method === "DELETE") {
    const body = await readJson(request) || {};
    const list = Array.isArray(body.sns) ? body.sns : body.sn ? [body.sn] : [];
    if (list.length === 0) return json({ error: "sn_required" }, 400);
    for (const sn of list) await deleteCredential(env, String(sn));
    return json({ ok: true, deleted: list.length });
  }

  if (path === "/admin/api/sns/disable-unbound" && method === "POST") {
    const sns = await disableUnbound(env);
    return json({ ok: true, disabled: sns.length, sns });
  }

  if (path === "/admin/api/sns/check" && method === "POST") {
    const body = await readJson(request) || {};
    if (body.all) {
      // 分页：默认每批 15 台，客户端带 cursor 逐批取，直到 done
      const limit = Math.min(Math.max(Number(body.limit) || 15, 1), 50);
      const cursor = Number(body.cursor) || 0;
      const r = await checkAll(env, { limit, cursor });
      const count = (st) => r.results.filter((x) => x.state === st).length;
      return json({
        ok: true,
        results: r.results,
        total: r.total,
        done: r.done,
        nextCursor: r.nextCursor,
        summary: {
          checked: r.results.length,
          ok: count("ok"),
          quota: count("quota"),
          limited: count("limited"),
          unbound: count("unbound"),
          failed: r.results.filter((x) => !x.ok && !x.state).length,
        },
      });
    }
    if (!body.sn) return json({ error: "sn_required" }, 400);
    const r = await checkCredential(env, String(body.sn));
    return json({ ok: r.ok, result: r });
  }

  return json({ error: "not_found" }, 404);
}

export { };
