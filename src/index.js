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
// 响应返回后运行时可能立即终止 isolate，fire-and-forget 的 KV 写会被砍掉。
// ctx.waitUntil() 能把这类后台任务挂住，保证写完。
function background(ctx, promise, label = "bg") {
  const p = Promise.resolve(promise).catch(logErr(label));
  try {
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  } catch (err) {
    console.warn("[background] waitUntil failed: " + (err && err.message ? err.message : err));
  }
  return p;
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 流式首事件探测失败（429 + device_retryable）：说明这台设备在限流，换一台。
async function looksDeviceRetryable(response) {
  if (response.status !== 429) return false;
  try {
    const data = await response.clone().json();
    return !!(data && data.error && data.error.device_retryable);
  } catch {
    return false;
  }
}

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
  async fetch(request, env, ctx) {
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
        const mRun = startRun({ route: "chat-method" });
        mRun.meta.path = pathname;
        mRun.meta.method = request.method;
        const mRec = mRun.finish("error", "method_not_allowed", {});
        background(ctx, commitRun(env, mRec), "commitRun-405");
        return json(errorBody("Method not allowed", "invalid_request_error"), 405, request);
      }
      const run = startRun({ route: "chat" });
      let streamCommitted = false;
      const finish = (record, response) => {
        // 关键 1：日志写 KV 不能阻塞返回。流式响应的 body 还在后台异步写入，
        // 这里 await 会让 client 迟迟拿不到流（背压卡死 → 0 字节）。
        background(ctx, commitRun(env, record), "commitRun");
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
      // 记录请求体摘要：消息条数、各角色、是否有 tools/stream、首条消息预览
      try {
        const msgs = Array.isArray(parsedBody && parsedBody.messages) ? parsedBody.messages : [];
        run.meta.req = {
          stream: !!(parsedBody && parsedBody.stream),
          msgs: msgs.length,
          roles: msgs.map((m) => m && m.role).join(","),
          tools: Array.isArray(parsedBody && parsedBody.tools) ? parsedBody.tools.length : 0,
          toolChoice: (parsedBody && parsedBody.tool_choice) || null,
          bodyBytes: rawBody.length,
          firstMsg: msgs[0] ? String(typeof msgs[0].content === "string" ? msgs[0].content : JSON.stringify(msgs[0].content)).slice(0, 80) : "",
          lastMsg: msgs.length ? String(typeof msgs[msgs.length - 1].content === "string" ? msgs[msgs.length - 1].content : JSON.stringify(msgs[msgs.length - 1].content)).slice(0, 80) : "",
        };
      } catch {
        // 摘要失败不影响主流程
      }

      // 用会话种子算出/取出该会话绑定的设备
      const seed = conversationSeed(parsedBody);
      // 绑定在做完一次成功后写入；已绑定就直接用，未绑定则让池子轮转
      const bound = await boundDevice(env, seed);
      run.step("bind", { bound: bound || "none" });
      run.meta.model = (parsedBody && parsedBody.model) || "";
      run.meta.seed = seed ? seed.slice(0, 24) : "";
      run.meta.token = gate.record.prefix;

      let response = null;
      let usedSn = "";
      let avoidSn = "";
      let quotaHit = 0;
      let lastFailureDetail = "";
      let inPlaceRetries = 0;
      for (let attempt = 0; attempt < RETRY_DEVICES; attempt++) {
        // 每次重试前都检查剩余预算：不够一次上游调用就直接收尾，
        // 别让调用方等 90 秒还拿不到东西。
        const elapsed = Date.now() - run.start;
        if (elapsed > REQUEST_DEADLINE_MS - 8000) {
          run.retry({ reason: "deadline", elapsed });
          break;
        }
        let cred;
        try {
          cred = await pick(env, { preferSn: attempt === 0 ? bound : "", avoidSn });
        } catch (e) {
          // 池子暂时没有可用设备：对调用方是"稍后重试"，不是"请求错误"
          const resp = json(
            {
              error: {
                message: `Credential pool unavailable: ${e.message}`,
                type: "rate_limit_error",
                param: null,
                code: "pool_empty",
                retryable: true,
                retry_after: 60,
              },
            },
            429,
            request
          );
          resp.headers.set("Retry-After", "60");
          const rec = run.finish("error", "pool_empty");
          return finish(rec, resp);
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
            handleChatCompletions(replay, env, cred, "pool", {
              token: gate.record,
              boundSn: bound,
              requestId: run.id,
              // 切片路径会用这两个做设备级重试与总预算控制
              pickDevice: async (tried) => {
                try {
                  return await pick(env, { avoidSn: (tried || []).slice(-1)[0] || "" });
                } catch {
                  return null;
                }
              },
              deadlineMs: Math.max(8000, REQUEST_DEADLINE_MS - (Date.now() - run.start) - 5000),
              startedAt: run.start,
              // 流结束时才提交日志（此时切片打点已全部记录）
              // 流结束时才提交：此时切片打点（batch-ms / chunk-ms）都已在 run.steps 里
              onStreamDone: async () => {
                if (streamCommitted) return;
                streamCommitted = true;
                const rec2 = run.finish("ok", null, { sn: usedSn, streaming: true });
                // 必须 await：isolate 可能在响应结束后被回收，fire-and-forget 会丢
                await commitRun(env, rec2);
              },
              onChunkEvent: (type, payload) => {
                if (type === "chunk-ms") run.step("chunk" + (payload.index + 1), { ms: payload.ms });
                else if (type === "retry") run.retry({ reason: "chunk-retry", ...payload });
                else if (type === "deadline") run.step("chunk-deadline", { elapsed: payload.elapsed });
                else if (type === "plan") run.step("chunk-plan", { chunks: payload.chunks });
                else if (type === "batch-ms") run.step("batch" + (payload.from + 1) + "-" + payload.count, { ms: payload.ms });
                else if (type === "chunk-failed") run.step("chunk-fail" + (payload.index + 1), { msg: payload.message });
              },
            }),
            Math.min(remain, 45000),
            "upstream"
          );
          run.step("upstream", { sn: usedSn, status: response.status });
        } catch (err) {
          await markFailure(env, usedSn, err.message);
          const rec = run.finish("error", err.message, { sn: usedSn });
          return finish(rec, json(errorBody(`Upstream error: ${err.message}`, "api_error", err.code || null), 502, request));
        }
        // 流式响应：streamResponse 内部已做首事件探测。
        // 若首事件是 error（伪成功/限流），会返回 429 + device_retryable，
        // 此时可以安全换设备重试；否则直接接受（绝不能再 clone，否则读空 body）。
        const respType = (response.headers.get("content-type") || "").toLowerCase();
        if (respType.includes("text/event-stream")) {
          break;
        }
        // 流式探测失败的 429：换设备重试
        if (response.status === 429 && (await looksDeviceRetryable(response))) {
          lastFailureDetail = "stream first-event error on " + usedSn.slice(-6);
          avoidSn = usedSn;
          response = null;
          continue;
        }

        // ① 配额耗尽：这是"这台设备今天用完了"，必须换设备——哪怕会话已绑定，
        //    因为留着它只会继续报错。换到的新设备会覆盖绑定。
        if (await looksQuotaExhausted(response)) {
          lastFailureDetail = "quota exhausted (4001) on " + usedSn.slice(-6);
          await markFailure(env, usedSn, "今日次数已用完", { quotaExhausted: true });
          quotaHit++;
          avoidSn = usedSn;
          response = null;
          continue;
        }
        // ② 不透明失败：先原地退避重试（限流多为瞬时），多次失败再换设备。
        if (!(await looksRetryable(response))) break;
        // 限流（伪成功）不占用外层"换设备"名额：原地最多再试 1 次就换设备
        if (inPlaceRetries < 1 && Date.now() - run.start < REQUEST_DEADLINE_MS - 10000) {
          inPlaceRetries++;
          run.retry({ reason: "opaque", sn: usedSn, n: inPlaceRetries });
          await sleep(1000);
          attempt--; // 原地重试不消耗换设备次数
          response = null;
          continue;
        }
        lastFailureDetail = "opaque success payload on " + usedSn.slice(-6);
        await markFailure(env, usedSn, "upstream opaque failure", { dead: false });
        avoidSn = usedSn;
        inPlaceRetries = 0;
        response = null;
      }
      if (!response) {
        const anyQuota = quotaHit > 0;
        const code = anyQuota ? "quota_exhausted" : "pool_exhausted";
        const retryAfter = anyQuota ? 3600 : 30;
        const detail = lastFailureDetail ? " Last upstream reply: " + lastFailureDetail : "";
        const rec = run.finish("error", code, { sn: usedSn, detail: lastFailureDetail });
        const resp = json(
          {
            error: {
              message: (anyQuota
                ? "All pool devices exhausted their daily quota (" + quotaHit + " checked)."
                : "All pool devices returned an opaque upstream failure.") + detail,
              type: "rate_limit_error",
              param: null,
              code: code,
              retryable: true,
              retry_after: retryAfter,
            },
          },
          429,
          request
        );
        resp.headers.set("Retry-After", String(retryAfter));
        return finish(rec, resp);
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
      background(ctx, markSuccess(env, usedSn), "markSuccess");
      background(ctx, consumeToken(env, gate.record), "consumeToken");
      background(ctx, recordRequestUsage(env, usedSn, gate.record.hash, delta), "usage");
      // 流式响应在返回 Response 时 body 还在持续写入，这里标注一下，
      // 免得把"响应头返回"误读成"全部内容已发出"。
      // 流式响应也必须写日志：之前直接 return 导致超长请求（切片流式）
      // 和普通流式请求在后台日志里完全找不到。
      const isStream = (response.headers.get("content-type") || "").includes("text/event-stream");
      if (isStream) {
        // 流式：打点在流进行中持续发生，等 onStreamDone 回调时再固化日志
        return response;
      }
      const rec = run.finish("ok", null, { sn: usedSn, streaming: false });
      return finish(rec, response);
    }

    // 未知路由：记录下来，否则"请求根本没到"和"路径拼错了"无法区分
    {
      const missRun = startRun({ route: "miss" });
      missRun.meta.path = pathname;
      missRun.meta.method = request.method;
      missRun.meta.query = url.search || "";
      missRun.meta.ua = (request.headers.get("user-agent") || "").slice(0, 80);
      const rec = missRun.finish("error", "not_found", {});
      background(ctx, commitRun(env, rec), "commitRun-404");
    }
    return json(errorBody(`Unknown route: ${pathname}`, "invalid_request_error", "not_found"), 404, request);
  },
};
