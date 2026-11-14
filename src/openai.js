import {
  generateChatId,
  login,
  parseUpstreamSSE,
  resolveCommonParams,
  resolveSecret,
  resolveUpstreamModel,
  sendChatTurn,
} from "./upstream.js";
import { estimateTokens, getCachedToken, setCachedToken } from "./history.js";
import { recordRequestUsage } from "./store.js";
import { appendTurn, ensureThread, loadMemory } from "./memory.js";
import { CORS_HEADERS, corsFor } from "./cors.js";
import {
  MESSAGE_BYTE_LIMIT,
  MESSAGE_CHAR_LIMIT,
  byteLength,
  exceedsLimit,
  planChunks,
  runLongMessage,
} from "./chunk.js";
import { computeSig } from "./md5.js";
import { injectPersona, personaBytes, resolvePersona } from "./persona.js";
import {
  buildAdapterHint,
  hasTools,
  parseToolCalls,
  renderToolResults,
  stripToolCalls,
  toolCallPayload,
} from "./tools.js";

// Injected as a prefix on the first turn of a brand-new conversation. Empty by
// default (no persona/system prompt is sent). Set a non-empty string to inject
// one.
const FIRST_TURN_SYSTEM_PROMPT = "";

// Long-input handling. The upstream rejects any single message over 1000
// characters ("内容长度不能超过1000"), so oversized user messages are split into
// consecutive turns of the same thread and merged back into one response. See
// src/chunk.js. Set CHUNKED_INPUT=false to disable and let the upstream error
// surface instead.
const CHUNKED_INPUT = true;

// Retries for opaque transient upstream failures ("success" payloads).
const UPSTREAM_RETRIES = 4;

// Account one completed request against both the device (sn) and the API token.
async function recordUsage(meta, promptTokens, completionTokens) {
  if (!meta || !meta.env) return;
  try {
    await recordRequestUsage(meta.env, meta.sn, meta.tokenHash || "", {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    });
  } catch (err) {
    console.error("[recordUsage] " + (err && err.message ? err.message : err));
  }
}

// Persona injection is handled in src/persona.js and applied to the live turn.
function err(message, type, code, status, cors = CORS_HEADERS) {
  return new Response(
    JSON.stringify({ error: { message, type, param: null, code } }),
    { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } }
  );
}

// Convert an upstream error payload into an OpenAI-style error response.
// 上游的"伪成功"包：{"code":200,"message":"success","data":null}。
// 它 httpStatus 是 200、event 是 error，但正文为空——不能当成成功返回。
export function isOpaqueSuccess(data) {
  if (!data || typeof data !== "object") return false;
  const msg = String(data.message || data.errMsg || data.errstr || "").trim();
  if (!/^success$/i.test(msg)) return false;
  const payload = data.data;
  const emptyPayload = payload === null || payload === undefined || (typeof payload === "object" && Object.keys(payload).length === 0);
  return emptyPayload;
}

function upstreamErrorResponse(data, cors = CORS_HEADERS) {
  const msg = (data && (data.message || data.errMsg || data.errstr)) || "upstream error";
  const code = (data && data.errno) || "upstream_error";
  return err(`Upstream: ${msg}`, "api_error", code, 502, cors);
}

// Normalize message content (string or OpenAI content-part array) to text.
export function contentToString(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p && p.text ? p.text : "")).join("");
  }
  return content == null ? "" : String(content);
}

// Fallback when the whole request exceeds the per-message limit: keep the
// head and the tail of the oldest message so the ask itself survives.
function cropForLimit(text, limit) {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  const head = Math.floor(limit * 0.4);
  const tail = limit - head;
  const note = "\n\n[…中间内容因上游单条消息字节上限已裁剪…]\n\n";
  return `${s.slice(0, head)}${note}${s.slice(-tail)}`;
}

// Keep the persona directive within the byte budget: when the turn is close to
// the limit, trim its tail before prepending (the chunked path re-splits it).
function cropForInject(text, reserved) {
  const s = String(text ?? "");
  if (!reserved) return s;
  const limit = Math.max(200, Math.floor(MESSAGE_BYTE_LIMIT * 0.9) - reserved);
  let cut = s.length;
  while (cut > 0 && byteLength(s.slice(0, cut)) > limit) cut -= Math.max(1, Math.floor(cut / 50));
  return cut >= s.length ? s : s.slice(0, cut);
}

// For the chunked path the frame has to fit into a single chunk (800 B budget
// minus body), so an oversized frame is reduced to its last (persistence) half.
function fitPersonaForChunk(persona, budget = 380) {
  if (!persona || !persona.text) return persona;
  if (personaBytes(persona) <= budget) return persona;
  const parts = splitFrame(persona.text, budget);
  return { ...persona, text: parts[parts.length - 1] };
}

// Split a directive into pieces that each fit one upstream message. Prefers line
// breaks so a frame is never cut mid-sentence.
function splitFrame(text, budget = 480) {
  const lines = String(text || "").split("\n");
  const out = [];
  let cur = "";
  for (const line of lines) {
    if (!cur) {
      cur = line;
      continue;
    }
    if (byteLength(cur + "\n" + line) > budget) {
      out.push(cur);
      cur = line;
    } else {
      cur += "\n" + line;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// 计算"本轮实际发给上游的内容"：人设帧 + 用户原文，必要时裁剪/拆分。
// 抽成纯函数便于单测，也让 handleChatCompletions 短一些。
export function composeLiveContent(liveContent, persona, { limit = MESSAGE_BYTE_LIMIT } = {}) {
  const text = String(liveContent ?? "");
  if (!persona || !persona.text) return { content: text, mode: "plain" };
  const total = byteLength(persona.text) + byteLength(text);
  if (total <= limit - 40) return { content: injectPersona(text, persona), mode: "inline" };
  if (byteLength(text) > limit - 120) return { content: injectPersona(text, persona), mode: "chunked" };
  // 正文短、帧太长：交给调用方的预热轮处理，这里只挂最后一段
  const parts = splitFrame(persona.text);
  return { content: injectPersona(text, { text: parts[parts.length - 1] }), mode: "preturn", parts };
}

// A chatId that only depends on the conversation seed, never on which device of
// the pool happened to serve it (otherwise a round-robin pool would split one
// OpenAI conversation across several upstream threads).
export function localChatId(sn, seed) {
  const tail = String(sn || "").slice(-13);
  const digest = computeSig({ seed: String(seed || ""), sn: String(seed || "") }, "");
  return `${tail}-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

// Replay plain (short) turns into a thread without exploding: anything beyond
// the per-message limit is cropped. Returns { final, replayedTo }.
// Latency budget for history replay. Replaying is fire-and-forget from the
// caller's point of view: it must never hold the live answer hostage.
const REPLAY_BUDGET_MS = 2500;
const REPLAY_MAX_TURNS = 12;

async function replayHistory(env, commonParams, secret, chatId, history, model, kind, limit, budgetMs = REPLAY_BUDGET_MS) {
  // 幂等：客户端重发同一段历史时，只补发 mem: 里还没出现过的那部分。
  let already = 0;
  try {
    const mem = await loadMemory(env, chatId);
    already = mem && Array.isArray(mem.turns) ? mem.turns.length : 0;
  } catch {
    already = 0;
  }
  if (!history || history.length === 0) return { replayedTo: 0, skipped: 0 };
  // 已经有记录的部分不再重放（mem 里存的是已发进该线程的轮次）
  const pending = already > 0 ? history.slice(already) : history;
  // 完全重复（客户端原样重发）时不再补发任何历史，只让实时轮次走
  if (pending.length === 0) return { replayedTo: history.length, skipped: 0, deduped: true, fullDuplicate: true };
  // Only the most recent turns matter for continuity; older ones are noise.
  const tail = pending.slice(-REPLAY_MAX_TURNS);
  const skippedHead = history.length - tail.length;
  const byteBudget = Math.min(limit, Math.floor(MESSAGE_BYTE_LIMIT / 3) - 1);

  const sendOne = async (m) => {
    let text = contentToString(m && m.content);
    if (!text) return "";
    if (byteLength(text) > limit) text = cropForLimit(text, byteBudget);
    const res = await sendChatTurn(env, commonParams, secret, {
      chatId,
      content: text,
      model,
      role: m.role === "assistant" ? "assistant" : "user",
      kind,
    });
    // Drain without blocking longer than the budget.
    await res.text();
    return text;
  };

  // Fire the replays with a hard deadline; the live turn goes out regardless.
  const work = (async () => {
    let done = 0;
    for (const m of tail) {
      try {
        await sendOne(m);
        done++;
      } catch {
        break;
      }
    }
    return done;
  })();

  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), budgetMs));
  const result = await Promise.race([work, timeout]);
  if (result === "timeout") {
    // Let the replays finish in the background so the thread still catches up.
    work.catch(() => {});
    return { replayedTo: skippedHead, skipped: tail.length, background: true };
  }
  return { replayedTo: skippedHead + result, skipped: tail.length - result };
}

function lastUserContent(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map((p) => (typeof p === "string" ? p : p && p.text ? p.text : ""))
          .join("");
      }
    }
  }
  return "";
}

export async function handleChatCompletions(request, env, cred, credentialSource = "default", ctx = {}) {
  const cors = corsFor(request);
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body", "invalid_request_error", null, 400, cors);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return err("'messages' must be a non-empty array", "invalid_request_error", null, 400, cors);
  }
  // 工具结果折成普通文本，上游协议没有 role:"tool"
  // 工具模式：simulate（默认，提示词模拟）/ passthrough（只把 role:tool 文本化）/ off（完全忽略）
  // 工具定义由 agent 注入；代理只做格式对齐与解析
  const toolsOn = hasTools(body);
  const messages = toolsOn ? renderToolResults(body.messages) : body.messages;
  // agent 负责注入工具定义；代理只补一句格式对齐，把调用块收敛成可解析的样子
  const toolPrompt = toolsOn ? buildAdapterHint(body.tool_choice) : "";

  const content = lastUserContent(messages);
  if (!content) {
    return err("No user message content found", "invalid_request_error", null, 400, cors);
  }

  const requestedModel = body.model || env.DEFAULT_MODEL || "deepseek-v3";
  const resolvedModel = resolveUpstreamModel(requestedModel);
  if (!resolvedModel) {
    return err(
      `The model '${requestedModel}' does not exist or is not supported. Supported models: deepseek-v3, deepseek-r1, baike.`,
      "invalid_request_error",
      "model_not_found",
      404,
      cors
    );
  }
  const { model, reasoning, kind } = resolvedModel;
  const stream = body.stream === true; // OpenAI default: non-streaming unless explicitly requested

  // Persona directive prepended to the live turn (see src/persona.js).
  // Per-model override table (src/persona.js MODEL_PERSONAS) decides the default.
  const persona = resolvePersona(request, body, env, requestedModel);

  // Resolve the auth token. The API key may carry one directly; otherwise we log
  // in with the client's sn + secret (cached per sn in KV) to obtain one.
  if (!request.headers.get("x-iot-token") && (!cred.token || typeof cred.token !== "string")) {
    const cached = await getCachedToken(env, cred.sn, cred.secret);
    if (cached) {
      cred.token = cached;
    } else {
      try {
        cred.token = await login(env, cred);
        await setCachedToken(env, cred.sn, cred.secret, cred.token);
      } catch (e) {
        return err(
          `Login failed: ${e.message}. Provide a valid 'secret-sn' or include a token.`,
          "authentication_error",
          "login_failed",
          401,
          cors
        );
      }
    }
  }

  // All device-specific params come from the client credential (public proxy).
  const commonParams = resolveCommonParams(cred, request);
  const secret = resolveSecret(cred);

  // Clear-context / new-chat signal. Upstream keeps conversation state keyed by
  // chatId, so "clearing" means starting a fresh chatId (see the APK's
  // clearContext). A new chat is chosen when any of these hold:
  //   - header x-iot-new-chat: true
  //   - a system message contains the marker [new_chat]
  //   - the request carries at most one non-system message (a lone user/assistant
  //     turn with no history) -> mirrors OpenAI's "stateless single message"
  //     mental model.
  const newChatHeader = (request.headers.get("x-iot-new-chat") || "").toLowerCase();
  const nonSystemCount = messages.filter((m) => m && m.role !== "system").length;
  const wantsNewChat =
    newChatHeader === "1" ||
    newChatHeader === "true" ||
    nonSystemCount <= 1 ||
    messages.some(
      (m) => m && m.role === "system" && typeof m.content === "string" && m.content.includes("[new_chat]")
    );

  // Determine the chat session. Priority:
  //   1. explicit x-iot-chat-id header (client owns the session)
  //   2. new-chat signal -> fresh chatId (clear context)
  //   3. multi-turn history -> a chatId derived from the conversation's first
  //      non-system message, so the same history reuses the same upstream thread
  //   4. otherwise -> most recent upstream thread
  let chatId = request.headers.get("x-iot-chat-id") || "";
  const pinnedChatId = chatId;
  if (!chatId && wantsNewChat) {
    chatId = generateChatId(commonParams.sn);
  }
  if (!chatId) {
    const firstNonSystem = messages.find((m) => m && m.role !== "system");
    const seedContent = firstNonSystem
      ? typeof firstNonSystem.content === "string"
        ? firstNonSystem.content
        : JSON.stringify(firstNonSystem.content)
      : content;
    chatId = localChatId(commonParams.sn, seedContent);
  }

  let warmupSent = false;
  // 记录本轮 chatId，供调用方在轮换设备时迁移记忆
  const sessionInfo = { chatId, remembered: false };
  // Warm-up turn: presets such as deepseek-r1's `r1` declare a standalone setup
  // message that must land as its own turn in this thread before the live
  // question. Without it, reasoning models classify the request as "give me an
  // exploit" and refuse; with it, the same request is classified as analysis.
  // Only sent for a fresh thread (new chat) so retries do not pile up.
  // 只在全新会话的第一轮发一次：重复注入会污染上下文，让模型以为在"重复设定"
  if (persona.warmup && !pinnedChatId && wantsNewChat && !stickySn) {
    try {
      const warm = await sendChatTurn(env, commonParams, secret, {
        chatId,
        content: persona.warmup,
        model,
        role: "user",
        kind,
      });
      await warm.text();
      warmupSent = true;
    } catch {
      // best-effort: the live turn still carries the full directive
    }
  }

  // Backfill: if this is a multi-turn request (history carries earlier turns),
  // replay the prefix into the upstream thread so the model remembers it. The
  // last user message is then sent as the live turn below. Backfill is a no-op
  // for single-message requests or when no HISTORY KV binding is configured.
  //
  // Every replayed/ live turn is cropped to the upstream's per-message limit;
  // oversized *live* messages take the chunked path instead (src/chunk.js).
  // Session stickiness: if this chatId already lives on a device, stay on it.
  // Rotating devices mid-conversation is what forces transcript replay and
  // produces the "he forgot what I said" effect.
  // 绑定由路由层（chatId → 设备）决定，handler 不再重复读 KV。
  const stickySn = ctx.boundSn || "";

  // Device rotation guard: if this chatId previously lived on another device
  // (the pool rotates), replay the stored transcript into the new one first, so
  // the caller does not silently lose the conversation.
  let rotated = null;
  try {
    rotated = await Promise.race([
      ensureThread(env, commonParams, secret, { chatId, sn: commonParams.sn, model, kind, turns: [] }),
      new Promise((r) => setTimeout(() => r(null), REPLAY_BUDGET_MS)),
    ]);
  } catch (err) {
    console.error("[memory] ensureThread failed: " + (err && err.message ? err.message : err));
  }

  const canBackfill = !pinnedChatId && !wantsNewChat;
  let lastReplayed = 0;
  const liveMessage = messages.filter((m) => m && m.role !== "system").slice(-1)[0];
  let liveContent = liveMessage ? contentToString(liveMessage.content) : content;

  // system 消息必须搬进 content：上游没有 system 通道，写在 role:"system" 里的内容
  // （典型是 agent 注入的工具定义）模型根本读不到。实测 0/3 vs 2/3 的调用率差异。
  const systemText = messages
    .filter((m) => m && m.role === "system")
    .map((m) => contentToString(m.content))
    .filter(Boolean)
    .join("\n");
  if (systemText) {
    liveContent = `${systemText}\n\n${liveContent}`;
  }
  if (canBackfill) {
    const history = messages.filter((m) => m && m.role !== "system").slice(0, -1);
    if (history.length > 0) {
      const { replayedTo } = await replayHistory(
        env,
        commonParams,
        secret,
        chatId,
        history,
        model,
        kind,
        MESSAGE_BYTE_LIMIT
      );
      lastReplayed = replayedTo;
    }
  }

  if (lastReplayed === 0 && FIRST_TURN_SYSTEM_PROMPT) {
    liveContent = `${FIRST_TURN_SYSTEM_PROMPT}\n\n${liveContent}`;
  }

  // Persona injection is applied after the size decision (see below), so a long
  // user message still takes the chunked path.

  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
  const promptTokens = estimateTokens(
    messages.map((m) => contentToString(m.content)).join("\n")
  );
  if (toolsOn && toolPrompt) {
    liveContent = `${toolPrompt}\n\n${liveContent}`;
  }

  const meta = {
    id,
    created,
    cropped: false,
    tools: toolsOn,
    toolNames: toolsOn
      ? (body.tools || []).map((t) => (t && (t.function || t) || {}).name).filter(Boolean)
      : [],
    // 参数校验用：name -> 工具定义（含 parameters）
    toolSchemas: toolsOn ? Object.fromEntries((body.tools || []).map((t) => {
      const fn = (t && (t.function || t)) || {};
      return [fn.name, { parameters: fn.parameters || null }];
    }).filter(([n]) => n)) : {},
    model: requestedModel,
    reasoning,
    promptTokens,
    sn: commonParams.sn,
    tokenHash: ctx.token ? ctx.token.hash : "",
    requestId: ctx.requestId || null,
    chatId,
    liveContent,
    env,
    pinnedChatId,
    credential: credentialSource,
    persona: persona.text ? persona.name : "off",
    warmup: warmupSent,
    personaSource: persona.source || "explicit",
    rotated: rotated && rotated.replayed ? rotated : null,
    personaModel: persona.model || null,
    // Lets every request of one OpenAI conversation reuse the same upstream
    // device (token cache / rate-limit bucket), even though the pool is random.
  };

  // The upstream counts the *whole request* (every message body, including any
  // user-supplied system message), not just the live turn, so short individual
  // messages can still trip the limit. If the request as a whole is oversized and
  // that is not already handled by chunking the live message, fall back to a
  // single cropped turn instead of bubbling up "内容长度不能超过1000".
  const totalBytes = messages
    .filter((m) => m && m.role !== "system")
    .reduce((n, m) => n + byteLength(contentToString(m.content)), 0);
  const chunkedLive = CHUNKED_INPUT && exceedsLimit(liveContent);
  if (!chunkedLive && totalBytes > MESSAGE_BYTE_LIMIT) {
    liveContent = cropForLimit(liveContent, Math.floor(MESSAGE_BYTE_LIMIT / 3) - 1);
    meta.cropped = true;
  }

  // --- Long-input path -----------------------------------------------------
  // The upstream rejects messages over 1000 chars. Split the live message into
  // consecutive turns of this thread, collect the final answer, and emit it as a
  // single (optionally streamed) OpenAI response.
  if (CHUNKED_INPUT && exceedsLimit(liveContent)) {
    const plan = planChunks(liveContent);
    meta.chunked = true;
    meta.chunks = plan.chunks;
    meta.truncated = plan.truncated;

    if (stream) {
      return streamLongMessage(request, env, commonParams, secret, {
        chatId,
        content: liveContent,
        model,
        kind,
        meta,
        cors,
        persona: fitPersonaForChunk(persona),
      });
    }

    let result;
    try {
      result = await runLongMessage(env, commonParams, secret, {
        chatId,
        content: liveContent,
        model,
        kind,
        persona: fitPersonaForChunk(persona),
      });
    } catch (e) {
      return err(`Upstream: ${e.message}`, "api_error", e.upstream?.errno || "upstream_error", 502, cors);
    }
    const payload = completionPayload(result.text, result.reason, { ...meta, chatId: result.chatId }, cors);
    return payload;
  }

  // --- Normal path ---------------------------------------------------------
  // The persona directive rides on the turn that carries the ask. Crop the tail
  // only if the two together would exceed the upstream budget.
  if (persona.text) {
    const composed = composeLiveContent(liveContent, persona, { limit: MESSAGE_BYTE_LIMIT });
    liveContent = composed.content;
    if (composed.mode === "preturn") {
      // 正文短、帧太长：先把前半段拆成预热轮发出去，正文只挂最后一段
      for (const part of composed.parts.slice(0, -1)) {
        try {
          const pre = await sendChatTurn(env, commonParams, secret, {
            chatId,
            content: part,
            model,
            role: "user",
            kind,
          });
          await pre.text();
        } catch (err) {
          console.error("[persona] pre-turn failed: " + (err && err.message ? err.message : err));
        }
      }
    }
  }

  // Transient upstream failures ({"errno":..., "message":"success"}) are retried
  // a few times before being reported, because the same request usually
  // succeeds on the next attempt.
  let upstream = null;
  let lastFailure = "";
  for (let attempt = 0; attempt <= UPSTREAM_RETRIES; attempt++) {
    upstream = await sendChatTurn(env, commonParams, secret, {
      chatId,
      content: liveContent,
      model,
      role: "user",
      kind,
    });
    if (upstream.ok) break;
    lastFailure = await upstream.text().catch(() => "");
    const opaque = /"message"\s*:\s*"success"/.test(lastFailure) || /^success$/.test(lastFailure.trim());
    if (!opaque || attempt === UPSTREAM_RETRIES) break;
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }

  if (!upstream || !upstream.ok) {
    return err(
      `Upstream HTTP ${upstream ? upstream.status : 502}: ${lastFailure.slice(0, 300)}`,
      "api_error",
      "upstream_error",
      502,
      cors
    );
  }

  if (!stream) {
    return aggregate(upstream, meta, cors);
  }

  return streamResponse(upstream, meta, cors);
}


// Non-streaming: collect all upstream chunks and emit a single JSON response.
async function aggregate(upstream, meta, cors) {
  let text = "";
  let reason = "";
  let upstreamChatId = "";
  let upstreamError = null;
  for await (const evt of parseUpstreamSSE(upstream)) {
    if (evt.event === "message" && evt.data) {
      if (typeof evt.data.content === "string") text += evt.data.content;
      if (typeof evt.data.reasonContent === "string") reason += evt.data.reasonContent;
    } else if (evt.event === "done" && evt.data && evt.data.chatId) {
      upstreamChatId = evt.data.chatId;
    } else if ((evt.event === "error" || evt.event === "notAllow") && evt.data) {
      // 第一段 error 只是 {"chatId","leftTimes"} 的进度包，真正的失败原因在后续帧里，
      // 所以保留"带 message 的那个"，没有 message 的只记降级信息。
      if (evt.data.message || evt.data.errMsg || evt.data.errstr || evt.data.errno) {
        upstreamError = evt.data;
      } else if (!upstreamError) {
        upstreamError = evt.data;
      }
    } else if (evt.data && typeof evt.data === "object" && evt.data.errno) {
      // Upstream sometimes replies with a bare JSON error object (no SSE frame),
      // e.g. {"errno":20600012,...,"message":"error.sn.null"}.
      upstreamError = evt.data;
    }
  }
  if (upstreamError && !text) {
    if (isOpaqueSuccess(upstreamError) || !upstreamError.message) {
      return err(
        "Upstream returned an empty success payload (opaque failure / rate limit). Retry later or use another device.",
        "api_error",
        "upstream_opaque_success",
        502,
        cors
      );
    }
    return upstreamErrorResponse(upstreamError, cors);
  }
  // 兜底：没有任何正文也没有明确错误 —— 同样是伪成功
  if (!text && !reason) {
    return err(
      "Upstream returned no content (possibly rate limited). Retry later.",
      "api_error",
      "upstream_empty",
      502,
      cors
    );
  }
  // 用量由路由层统一记账（含 sn + token + 当日），这里不再重复写
  if (!meta.tokenHash) await recordUsage(meta, meta.promptTokens || 0, estimateTokens(text + reason));
  if (meta.chatId && text) {
    try {
      await appendTurn(meta.env, meta.chatId, meta.sn, "user", meta.liveContent || "");
      await appendTurn(meta.env, meta.chatId, meta.sn, "assistant", text);
    } catch (err) {
      console.error("[memory] append failed: " + (err && err.message ? err.message : err));
    }
  }
  const headers = { "Content-Type": "application/json; charset=utf-8", ...cors };
  if (upstreamChatId) headers["x-iot-chat-id"] = upstreamChatId;
  return completionPayload(text, reason, meta, cors, headers);
}

// Build the non-streaming chat.completion payload for a finished answer.
function completionPayload(text, reason, meta, cors, extraHeaders = null) {
  // 工具模式：把模型输出的 <tool_call> 块转成标准 tool_calls
  let toolCalls = null;
  if (meta.tools) {
    toolCalls = parseToolCalls(text, meta.toolNames || [], meta.toolSchemas || {});
    if (toolCalls.rejected && toolCalls.rejected.length > 0) {
      console.warn("[tools] rejected invalid call(s): " + JSON.stringify(toolCalls.rejected).slice(0, 300));
    }
  }
  const message = toolCalls && toolCalls.length > 0
    ? toolCallPayload(text, toolCalls)
    : { role: "assistant", content: text || "" };
  if (reason) message.reasoning_content = reason;
  const completionTokens = estimateTokens((text || "") + (reason || ""));
  const promptTokens = meta.promptTokens || 0;
  const payload = {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls && toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
  if (meta.tools) {
    payload["x_iot"] = { ...(payload["x_iot"] || {}), tools: true, toolCalls: toolCalls ? toolCalls.length : 0 };
  }
  if (meta.chunked || meta.cropped || (meta.persona && meta.persona !== "off")) {
    payload["x_iot"] = {
      chunked: !!meta.chunked,
      chunks: meta.chunks || 0,
      truncated: !!meta.truncated,
      cropped: !!meta.cropped,
      credential: meta.credential || null,
      persona: meta.persona || null,
      warmup: !!meta.warmup,
      personaSource: meta.personaSource || null,
      personaModel: meta.personaModel || null,
    };
  }
  const headers = extraHeaders
    ? { ...extraHeaders }
    : { "Content-Type": "application/json; charset=utf-8", ...cors };
  // 设备信息不外泄：调用方按 chatId 维持会话即可
  if (meta.chatId) headers["x-iot-chat-id"] = meta.chatId;
  return new Response(JSON.stringify(payload), { headers });
}

// Streaming: translate upstream SSE events to OpenAI chat.completion.chunk frames.
function streamResponse(upstream, meta, cors) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (obj) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  const frame = (delta, finish = null) => ({
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  // Signal an X-IoT-Chat-Id response header. With a streamed body the status
  // line is already sent, so we expose the chatId as a first SSE comment and in
  // a custom chunk-less header is not possible; instead we emit it as a
  // non-standard field on the final [DONE]-adjacent frame meta is not sent.
  // Simpler: clients should pin chatId via x-iot-chat-id, but we still surface
  // it as a comment line for observability.
  let chatIdCommentSent = false;

  (async () => {
    let sawError = null;
    let sawText = false;
    let toolFramesSent = false;
    let completionText = "";
    try {
      // Flush the headers immediately (empty chunk) so the client sees the
      // stream open instead of waiting on the upstream's first token.
      // 立刻吐一个注释帧，让客户端尽快进入流式状态
      await writer.write(encoder.encode(": open\n\n"));
      await send(frame({ role: "assistant", content: "" }));

      for await (const evt of parseUpstreamSSE(upstream)) {
        if (evt.event === "message" && evt.data) {
          const reason = evt.data.reasonContent;
          if (typeof reason === "string" && reason.length > 0) {
            completionText += reason;
            await send(frame({ reasoning_content: reason }));
          }
          const piece = evt.data.content;
          if (typeof piece === "string" && piece.length > 0) {
            sawText = true;
            completionText += piece;
            await send(frame({ content: piece }));
          }
        } else if (evt.event === "done") {
          if (evt.data && evt.data.chatId && !chatIdCommentSent) {
            chatIdCommentSent = true;
            await writer.write(encoder.encode(`: x-iot-chat-id ${evt.data.chatId}\n\n`));
          }
        } else if ((evt.event === "error" || evt.event === "notAllow") && evt.data) {
          // 同上：进度包没有 message，不能覆盖真正的错误原因
          if (evt.data.message || evt.data.errMsg || evt.data.errstr || evt.data.errno) {
            sawError = evt.data;
          } else if (!sawError) {
            sawError = evt.data;
          }
        }
      }

      // 工具模式：文本帧已经边收边发过了；这里只在结束时补 tool_calls 帧。
      // 不再整段缓冲——否则上游流一慢，客户端就长时间收不到任何东西。
      if (meta.tools) {
        const calls = parseToolCalls(completionText, meta.toolNames || [], meta.toolSchemas || {});
        if (calls.rejected && calls.rejected.length > 0) {
          console.warn("[tools] rejected invalid call(s): " + JSON.stringify(calls.rejected).slice(0, 300));
        }
        if (calls.length > 0) {
          const deltas = calls.map((c, i) => ({
            index: i,
            id: c.id,
            type: "function",
            function: { name: c.function.name, arguments: c.function.arguments },
          }));
          await send({
            id: meta.id,
            object: "chat.completion.chunk",
            created: meta.created,
            model: meta.model,
            choices: [{ index: 0, delta: { tool_calls: deltas }, finish_reason: "tool_calls" }],
          });
        } else {
          await send(frame({}, "stop"));
        }
        // 不 return：继续走下面的 usage 帧与 [DONE]，否则客户端收不到结束标记
        toolFramesSent = true;
      }

      if (!toolFramesSent && sawError && !sawText) {
        const opaque = isOpaqueSuccess(sawError) || !sawError.message;
        const msg = opaque
          ? "upstream opaque success (rate limited)"
          : sawError.message || sawError.errMsg || sawError.errstr || "upstream error";
        // 用错误帧 + finish_reason=error，让客户端能识别这不是正常回答
        await send({
          id: meta.id,
          object: "chat.completion.chunk",
          created: meta.created,
          model: meta.model,
          choices: [{ index: 0, delta: { content: `[upstream error: ${msg}]` }, finish_reason: "error" }],
          error: { message: msg, code: opaque ? "upstream_opaque_success" : "upstream_error" },
        });
      } else if (!toolFramesSent && !sawText) {
        await send({
          id: meta.id,
          object: "chat.completion.chunk",
          created: meta.created,
          model: meta.model,
          choices: [{ index: 0, delta: { content: "[upstream error: empty response]" }, finish_reason: "error" }],
          error: { message: "upstream returned no content", code: "upstream_empty" },
        });
      } else if (!toolFramesSent) {
        await send(frame({}, "stop"));
      }
      // Final usage frame (OpenAI sends usage on the last chunk when enabled).
      const promptTokens = meta.promptTokens || 0;
      const completionTokens = estimateTokens(completionText);
      await send({
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
      if (!meta.tokenHash) await recordUsage(meta, promptTokens, completionTokens);
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (e) {
      await send(frame({ content: `\n[proxy error: ${e.message}]` }, "stop"));
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(meta.requestId ? { "x-request-id": meta.requestId } : {}),
      ...cors,
    },
  });
}

// Streaming wrapper for the chunked path: run every chunk upstream, then emit the
// final answer as ordinary chat.completion.chunk frames. Progress of the staging
// turns is surfaced as SSE comments so clients can show what is happening.
function streamLongMessage(request, env, commonParams, secret, { chatId, content, model, kind, meta, cors, persona }) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (chunk) => writer.write(encoder.encode(chunk));

  const frame = (delta, finish = null) => ({
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  (async () => {
    try {
      await write(`: x-iot-chunked true chunks=${meta.chunks || 0}\n\n`);
      if (meta.persona) await write(`: x-iot-persona ${meta.persona}\n\n`);
      await write(`data: ${JSON.stringify(frame({ role: "assistant", content: "" }))}\n\n`);

      const result = await runLongMessage(env, commonParams, secret, {
        chatId,
        content,
        model,
        kind,
        persona,
        onEvent: (type, payload) => {
          if (type === "chunk") {
            write(`: x-iot-progress ${payload.index + 1}/${payload.total}\n\n`).catch(() => {});
          }
        },
      });

      // Reasoning first, then content, mirroring the normal streaming order.
      const reason = result.reason || "";
      for (let i = 0; i < reason.length; i += 200) {
        await write(`data: ${JSON.stringify(frame({ reasoning_content: reason.slice(i, i + 200) }))}\n\n`);
      }
      const text = result.text || "";
      for (let i = 0; i < text.length; i += 80) {
        await write(`data: ${JSON.stringify(frame({ content: text.slice(i, i + 80) }))}\n\n`);
      }
      await write(`data: ${JSON.stringify(frame({}, "stop"))}\n\n`);

      const promptTokens = meta.promptTokens || 0;
      const completionTokens = estimateTokens(text + reason);
      await write(
        `data: ${JSON.stringify({
          id: meta.id,
          object: "chat.completion.chunk",
          created: meta.created,
          model: meta.model,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        })}\n\n`
      );
      if (!meta.tokenHash) await recordUsage(meta, promptTokens, completionTokens);
      if (result.chatId) await write(`: x-iot-chat-id ${result.chatId}\n\n`);
      await write("data: [DONE]\n\n");
    } catch (e) {
      await write(`data: ${JSON.stringify(frame({ content: `[upstream error: ${e.message}]` }, "stop"))}\n\n`);
      await write("data: [DONE]\n\n");
    } finally {
      try {
        await writer.close();
      } catch {
        // already closed
      }
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(meta.requestId ? { "x-request-id": meta.requestId } : {}),
      ...cors,
    },
  });
}
