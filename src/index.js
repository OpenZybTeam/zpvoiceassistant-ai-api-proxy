import { contentToString, handleChatCompletions } from "./openai.js";
import { handleModels } from "./models.js";
import { extractApiKey } from "./credential.js";
import { corsFor } from "./cors.js";
import { renderHome } from "./ui.js";
import { getUsage } from "./history.js";
import { MESSAGE_CHAR_LIMIT } from "./chunk.js";
import { handleAdmin } from "./admin.js";
import { consumeToken, verifyToken } from "./token.js";
import { markFailure, markSuccess, pick } from "./snpool.js";
import { hasKV, recordRequestUsage } from "./store.js";
import { REQUEST_DEADLINE_MS, commitRun, startRun, withTimeout } from "./runlog.js";
import { getBinding, loadMemory, setBinding } from "./memory.js";
import { DEFAULT_PERSONA, PRESETS, PROFILES, STACKS, modelPersonas, personaBytes, resolvePersona } from "./persona.js";

function json(data, status = 200, request = null) {
  const cors = request ? corsFor(request) : { "Access-Control-Allow-Origin": "*" };
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

// Human-readable messages for token verification failures.
function tokenErrorMessage(code) {
  switch (code) {
    case "token_disabled":
      return "API key has been disabled.";
    case "token_expired":
      return "API key has expired.";
    case "token_exhausted":
      return "API key has reached its usage limit.";
    default:
      return "Invalid API key. Create one in /admin.";
  }
}

// 会话种子：优先用首条非 system 消息（与 openai.js 的 chatId 派生保持一致），
// 这样同一段对话每次算出来的种子都相同。
// 会话种子：
//   1. 客户端显式传 chat_id / conversation_id 字段 → 直接用它（最稳）
//   2. 否则取「第一条非 system 消息」的文本，同一段对话每次算出来的都相同
function conversationSeed(body) {
  if (body && typeof body.chat_id === "string" && body.chat_id.trim()) return body.chat_id.trim();
  if (body && typeof body.conversation_id === "string" && body.conversation_id.trim()) {
    return body.conversation_id.trim();
  }
  if (body && typeof body.user === "string" && body.user.trim()) return body.user.trim();
  const msgs = (body && Array.isArray(body.messages) ? body.messages : []).filter(
    (m) => m && m.role !== "system"
  );
  if (msgs.length === 0) return "";
  return contentToString(msgs[0].content);
}

// 该会话当前绑定的设备。没有则返回空串，由 pool 轮转决定；决定后写回绑定表，
// 后续同一会话的请求都会落回同一台设备。
async function boundDevice(env, seed) {
  if (!seed || !hasKV(env)) return "";
  try {
    return await getBinding(env, seed);
  } catch {
    return "";
  }
}

// Devices tried per request when the first one returns the opaque failure.
const RETRY_DEVICES = 3;

// Detect the upstream's disguised failure so the request can be retried on
// another device. The response is cloned, so the caller still sees the body.
// 上游配额耗尽：{"code":4001,"message":"今日次数已用完"} 或文本形式的同义报错。
async function looksQuotaExhausted(response) {
  const clone = response.clone();
  let text = "";
  try {
    text = await clone.text();
  } catch {
    return false;
  }
  return /今日次数已用完|次数已用完|quota\s*exhausted|daily\s*limit/i.test(text);
}

// 统一的错误日志钩子（P2-9：不再静默吞错）
function logErr(where) {
  return (err) => {
    try {
      console.error(`[${where}] ${err && err.message ? err.message : err}`);
    } catch {
      // nothing else we can do
    }
  };
}

// 指数退避：命中限流类失败后先在同一台设备上等待重试，避免"连打三台全被限"。
const BACKOFF_BASE_MS = 1500;
const BACKOFF_MAX_RETRIES = 3; // 每台设备最多原地重试次数
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 上游"伪成功"已经在 openai.js 里转成 502 + code=upstream_opaque_success，
// 这里只要看 code 就能判断要不要换设备重试。
async function looksRetryable(response) {
  if (response.status < 500) return false;
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("application/json")) return false;
  try {
    const data = await response.clone().json();
    const code = String(data?.error?.code || "");
    const message = String(data?.error?.message || "");
    return code === "upstream_opaque_success" || code === "upstream_empty" || /opaque|no content/i.test(message);
  } catch {
    return false;
  }
}

function errorBody(message, type = "invalid_request_error", code = null) {
  return { error: { message, type, param: null, code } };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsFor(request) });
    }

    // Admin panel: setup, login, token/pool management, usage dashboard.
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      if (!hasKV(env)) {
        return json(
          errorBody("Admin requires the HISTORY KV binding. Run 'wrangler kv namespace create HISTORY' and set the id in wrangler.toml.", "api_error", "no_storage"),
          503,
          request
        );
      }
      return handleAdmin(request, env);
    }

    // Health check (no auth) so the worker is easily probeable.
    if (pathname === "/health") {
      return json(
        {
          status: "ok",
          service: "iot-ai-proxy",
          auth: "sk-token",
          credentialSource: "kv-pool",
          storage: hasKV(env) ? "kv" : "none",
          messageCharLimit: MESSAGE_CHAR_LIMIT,
        },
        200,
        request
      );
    }

    // Home page: chat UI for debugging (no API key field any more).
    if ((pathname === "/" || pathname === "/ui") && (request.method === "GET" || request.method === "HEAD")) {
      return renderHome(request.headers.get("x-mount-base") || "", 0);
    }

    // Jailbreak presets / frames available for injection.
    if (pathname === "/v1/personas" && request.method === "GET") {
      return json(
        {
          object: "list",
          default: DEFAULT_PERSONA,
          modelPersonas: modelPersonas(env),
          presets: Object.entries(PRESETS).map(([id, p]) => ({ id, base: p.base, frames: p.frames })),
          frames: Object.keys(STACKS),
          base: Object.keys(PROFILES),
          note: "Use x-iot-persona: <preset>, optionally x-iot-stacks: a,b to append frames.",
        },
        200,
        request
      );
    }

    // Convenience route: POST /v1/persona { "preset": "redteam", "stacks": ["compare"] }
    // returns the exact directive that would be injected, without calling upstream.
    if (pathname === "/v1/persona" && request.method === "POST") {
      let body = {};
      try {
        body = await request.json();
      } catch {
        return json(errorBody("Invalid JSON body", "invalid_request_error", null), 400, request);
      }
      const pseudo = {
        headers: {
          get: (k) =>
            k === "x-iot-persona"
              ? String(body.preset || body.persona || "")
              : k === "x-iot-stacks"
                ? Array.isArray(body.stacks)
                  ? body.stacks.join(",")
                  : String(body.stacks || "")
                : "",
        },
      };
      const persona = resolvePersona(pseudo, body, env, String(body.model || ""));
      return json(
        {
          object: "persona",
          name: persona.name,
          base: persona.base,
          frames: persona.frames,
          stacked: persona.stacked,
          source: persona.source,
          model: persona.model,
          bytes: personaBytes(persona),
          text: persona.text,
        },
        200,
        request
      );
    }

    // Public model list for OpenAI-compatible clients.
    if (pathname === "/v1/models" && request.method === "GET") {
      return handleModels(env, corsFor(request));
    }

    // Token usage for the calling API key.
    if (pathname === "/v1/usage" && request.method === "GET") {
      const gate = await verifyToken(env, extractApiKey(request));
      if (gate.error) {
        return json(errorBody(tokenErrorMessage(gate.error), "authentication_error", gate.error), 401, request);
      }
      const usage = await getUsage(env, gate.record.hash);
      return json(
        {
          object: "usage",
          token: gate.record.prefix,
          note: gate.record.note,
          uses: gate.record.uses || 0,
          maxUses: gate.record.maxUses || 0,
          expiresAt: gate.record.expiresAt || 0,
          ...usage,
        },
        200,
        request
      );
    }

    if (pathname === "/v1/chat/completions") {
      if (request.method !== "POST") {
        return json(errorBody("Method not allowed", "invalid_request_error"), 405, request);
      }
      const run = startRun({ route: "chat" });
      const finish = (record, response) => {
        // 关键 1：日志写 KV 不能阻塞返回。流式响应的 body 还在后台异步写入，
        // 这里 await 会让 client 迟迟拿不到流（背压卡死 → 0 字节）。
        commitRun(env, record).catch(() => {});
        // 关键 2：不能用 new Response(response.body, ...) 重新包装，直接改原对象 headers。
        if (response && response.headers) {
          try {
            response.headers.set("x-request-id", run.id);
          } catch (err) {
            console.warn("[finish] cannot set header: " + (err && err.message ? err.message : err));
          }
        }
        return response;
      };

      // API key handling: a real sk- token from the admin panel is required.
      // Its record drives expiry / per-use quota / enable switches, and usage is
      // accounted against both the token and the device that served the call.
      const presented = extractApiKey(request);
      const gate = await verifyToken(env, presented);
      run.step("auth", { token: gate.record ? gate.record.prefix : "invalid" });
      if (gate.error) {
        const rec = run.finish("error", gate.error, { token: presented ? presented.slice(0, 8) : "" });
        return finish(rec, json(errorBody(tokenErrorMessage(gate.error), "authentication_error", gate.error), 401, request));
      }

      // 设备绑定完全由 chatId 决定：同一个会话始终落回同一台设备。
      // 客户端不需要（也不应该）通过请求头参与设备选择。
      // Buffer the body once: a retry on another device has to resend the exact
      // same bytes, and a Request body can only be consumed once.
      let rawBody = "";
      let parsedBody = null;
      try {
        rawBody = await request.clone().text();
        parsedBody = JSON.parse(rawBody);
      } catch {
        return json(errorBody("Invalid JSON body", "invalid_request_error", null), 400, request);
      }

      run.step("body", { bytes: rawBody.length, model: parsedBody && parsedBody.model });

      // 用会话种子算出/取出该会话绑定的设备
      const seed = conversationSeed(parsedBody);
      // 绑定在做完一次成功后写入；已绑定就直接用，未绑定则让池子轮转
      const bound = await boundDevice(env, seed);
      run.step("bind", { bound: bound || "none" });
      run.meta.model = (parsedBody && parsedBody.model) || "";
      run.meta.token = gate.record.prefix;
      run.meta.seed = seed ? seed.slice(0, 24) : "";

      let response = null;
      let usedSn = "";
      let avoidSn = "";
      let quotaHit = 0;
      let inPlaceRetries = 0;
      for (let attempt = 0; attempt < RETRY_DEVICES; attempt++) {
        // 剩余预算不够一次上游调用时，停止重试，直接给出已有失败原因
        if (Date.now() - run.start > REQUEST_DEADLINE_MS - 8000) {
          run.retry({ reason: "deadline", elapsed: Date.now() - run.start });
          break;
        }
        let cred;
        try {
          cred = await pick(env, { preferSn: attempt === 0 ? bound : "", avoidSn });
        } catch (e) {
          return json(errorBody(`Credential pool: ${e.message}`, "api_error", "pool_empty"), 503, request);
        }
        usedSn = cred.sn;
        run.step("pick", { sn: usedSn, attempt: attempt + 1 });
        run.meta.sn = usedSn;
        if (cred.sn !== (parsedBody && parsedBody.sn)) {
          // Fresh per-device login token; cached by sn+secret in KV.
          cred = { ...cred };
        }
        try {
          const replay = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: rawBody,
          });
          // 单次上游调用加超时：卡死时立刻失败，而不是让 agent 干等
          const remain = Math.max(5000, REQUEST_DEADLINE_MS - (Date.now() - run.start));
          response = await withTimeout(
            handleChatCompletions(replay, env, cred, "pool", { token: gate.record, boundSn: bound, requestId: run.id }),
            Math.min(remain, 45000),
            "upstream"
          );
          run.step("upstream", { sn: usedSn, status: response.status });
        } catch (err) {
          await markFailure(env, usedSn, err.message);
          const rec = run.finish("error", err.message, { sn: usedSn });
          return finish(rec, json(errorBody(`Upstream error: ${err.message}`, "api_error", err.code || null), 502, request));
        }
        // 流式响应必须直接接受：任何 clone/text() 检查都会把 body 读空，
        // 客户端会收到 200 + text/event-stream + 0 字节。
        const respType = (response.headers.get("content-type") || "").toLowerCase();
        if (respType.includes("text/event-stream")) {
          break;
        }

        // ① 配额耗尽：这是"这台设备今天用完了"，必须换设备——哪怕会话已绑定，
        //    因为留着它只会继续报错。换到的新设备会覆盖绑定。
        if (await looksQuotaExhausted(response)) {
          await markFailure(env, usedSn, "今日次数已用完", { quotaExhausted: true });
          quotaHit++;
          avoidSn = usedSn;
          response = null;
          continue;
        }
        // ② 不透明失败：先原地退避重试（限流多为瞬时），多次失败再换设备。
        if (!(await looksRetryable(response))) break;
        if (inPlaceRetries < BACKOFF_MAX_RETRIES) {
          inPlaceRetries++;
          run.retry({ reason: "opaque", sn: usedSn, n: inPlaceRetries });
          await sleep(BACKOFF_BASE_MS * 2 ** (inPlaceRetries - 1));
          attempt--; // 原地重试不消耗换设备次数
          response = null;
          continue;
        }
        await markFailure(env, usedSn, "upstream opaque failure", { dead: false });
        avoidSn = usedSn;
        inPlaceRetries = 0;
        response = null;
      }
      if (!response) {
        const anyQuota = quotaHit > 0;
        const rec = run.finish("error", anyQuota ? "quota_exhausted" : "pool_exhausted", { sn: usedSn });
        return finish(rec, json(
          errorBody(
            anyQuota
              ? `All pool devices exhausted their daily quota (${quotaHit} checked). Add more devices in /admin or retry after midnight.`
              : "All pool devices returned the opaque upstream failure",
            "api_error",
            anyQuota ? "quota_exhausted" : "pool_exhausted"
          ),
          502,
          request
        ));
      }

      // 记录会话 -> 设备绑定，后续同一会话不再轮换。
      // 这一步必须带超时：KV 慢或限流时曾把请求硬拖到 45 秒以上。
      try {
        await withTimeout(setBinding(env, seed, usedSn), 1500, "setBinding");
      } catch (err) {
        run.step("binding-skipped", { error: String(err && err.message) });
      }

      // 记账并行，不阻塞响应；用量计数在 store 里合并成一次写。
      const delta = {
        prompt_tokens: Number(response.headers.get("x-iot-prompt-tokens") || 0),
        completion_tokens: Number(response.headers.get("x-iot-completion-tokens") || 0),
      };
      Promise.all([
        markSuccess(env, usedSn).catch(logErr("markSuccess")),
        consumeToken(env, gate.record).catch(logErr("consumeToken")),
        recordRequestUsage(env, usedSn, gate.record.hash, delta).catch(logErr("usage")),
      ]).catch(() => {});
      // 流式响应在返回 Response 时 body 还在持续写入，这里标注一下，
      // 免得把"响应头返回"误读成"全部内容已发出"。
      const isStream = (response.headers.get("content-type") || "").includes("text/event-stream");
      if (isStream) return response;
      const rec = run.finish("ok", null, { sn: usedSn, streaming: isStream });
      return finish(rec, response);
    }

    return json(errorBody(`Unknown route: ${pathname}`, "invalid_request_error", "not_found"), 404, request);
  },
};
