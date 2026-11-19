// Long-input handling: workaround for the upstream's length limit on a chat
// message ("内容长度不能超过1000").
//
// Measured upstream behaviour (see README):
//   * the server counts UTF-8 bytes, not characters: pure-ASCII text is still
//     accepted at 4000 chars (4000 bytes), while CJK text is rejected from the
//     334th character on (333 chars x 3 bytes = 999 bytes);
//   * the accounting spans the whole request body of the thread, so user-supplied
//     system messages and replayed history count too;
//   * the thread also has a request quota — too many turns in one chatId are
//     answered with {"errno":..., "message":"success"} (a disguised rate limit).
//
// Strategy
// --------
// Turn one oversized user message into a sequence of small turns inside a single
// thread and let the last one carry the instruction:
//
//   chunk 1  (<= 800 bytes)   ─┐
//   chunk 2  (<= 800 bytes)   ─┼─> plain user turns, each acknowledged briefly
//   ...                        ┘
//   tail     = final chunk + "请根据以上全部内容……" instruction
//
// Pieces are cut at the byte budget (never splitting a UTF-8 sequence, surrogate
// pair or CRLF) and preferably on natural boundaries. After the last chunk the
// proxy posts an assistant turn with the answer so the thread stays well-formed
// and a reused chatId does not re-run the task.

import { injectPersona, personaBytes } from "./persona.js";
import { parseUpstreamSSE, sendChatTurn } from "./upstream.js";
import { markFailure, markSuccess, pick } from "./snpool.js";

// Character cap the upstream advertises (kept for docs / error messages).
export const MESSAGE_CHAR_LIMIT = 1000;
// Real budget: the measured byte limit for one request body (999 is safe).
export const MESSAGE_BYTE_LIMIT = 1000;
// Per-chunk byte budget: leaves room for the stitched instruction.
export const CHUNK_BYTES = 800;
// The upstream occasionally answers a perfectly valid turn with a bare
// {"errno":..., "message":"success"} payload — an opaque, transient failure.
// Retry such turns a few times before surfacing the error.
export const TURN_RETRIES = 4;
const RETRY_DELAY_MS = 1500;
// Upper bound of chunks a single request may fan out into (~19 kB of input).
export const MAX_CHUNKS = 24;

const encoder = new TextEncoder();

export function charLength(text) {
  return String(text ?? "").length;
}

export function byteLength(text) {
  return encoder.encode(String(text ?? "")).length;
}

// True when the request body would be rejected by the upstream (byte based).
export function exceedsLimit(text) {
  return byteLength(text) > MESSAGE_BYTE_LIMIT;
}

// Split text so that every piece is at most `budget` UTF-8 bytes. Boundaries are
// preferred at newlines, sentence punctuation and spaces; surrogate pairs, CRLF
// and multi-byte sequences are never cut in half.
export function splitMessage(text, budget = CHUNK_BYTES) {
  const s = String(text ?? "");
  if (byteLength(s) <= budget) return [s];

  const pieces = [];
  let rest = s;
  const boundaries = ["\n\n", "\n", "。", "！", "？", "；", ". ", "! ", "? ", "; ", "，", ",", " "];

  while (byteLength(rest) > budget) {
    // Walk characters until the byte budget is reached.
    let cut = 0;
    let used = 0;
    while (cut < rest.length) {
      const ch = String.fromCodePoint(rest.codePointAt(cut));
      const size = encoder.encode(ch).length;
      if (used + size > budget) break;
      used += size;
      cut += ch.length;
    }
    if (cut === 0) cut = 1;

    // Prefer a natural boundary within the last 120 bytes of the window.
    const floor = Math.max(0, cut - 120);
    for (const b of boundaries) {
      const idx = rest.lastIndexOf(b, cut - 1);
      if (idx !== -1 && idx + b.length > floor) {
        cut = idx + b.length;
        break;
      }
    }
    // Never split a surrogate pair or a CRLF pair.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut += 1;
    if (rest[cut - 1] === "\r" && rest[cut] === "\n") cut += 1;

    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

export function planChunks(text, budget = CHUNK_BYTES, max = MAX_CHUNKS) {
  const content = String(text ?? "");
  if (!exceedsLimit(content)) {
    return { pieces: [content], chunks: 1, oversize: false, truncated: false, bytes: byteLength(content) };
  }
  let pieces = splitMessage(content, budget);
  let truncated = false;
  if (pieces.length > max) {
    pieces = pieces.slice(0, max);
    truncated = true;
  }
  return { pieces, chunks: pieces.length, oversize: true, truncated, bytes: byteLength(content) };
}

// Wording used to stitch the pieces back together. Kept short so that
// CHUNK_BYTES + instruction stays below the byte limit.
function continuationInstruction(index, total) {
  if (index === total - 1) return "（以上是全文，请一次性给出完整回答。）";
  // 中间片只是"喂内容"。注意：不要让模型"只回收到"——实测上游对这类
  // 指令更容易返回伪成功包，反而更慢。
  return "（继续，先记下这段。）";
}

// Send one natural user turn and return the streamed assistant text.
async function sendTurn(env, commonParams, secret, { chatId, content, model, kind, role = "user" }) {
  const res = await sendChatTurn(env, commonParams, secret, { chatId, content, model, role, kind });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`upstream HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  let text = "";
  let reason = "";
  let upstreamChatId = "";
  let upstreamError = null;
  for await (const evt of parseUpstreamSSE(res)) {
    if (evt.event === "message" && evt.data) {
      if (typeof evt.data.content === "string") text += evt.data.content;
      if (typeof evt.data.reasonContent === "string") reason += evt.data.reasonContent;
    } else if (evt.event === "done" && evt.data && evt.data.chatId) {
      upstreamChatId = evt.data.chatId;
    } else if ((evt.event === "error" || evt.event === "notAllow") && evt.data) {
      upstreamError = evt.data;
    } else if (evt.data && typeof evt.data === "object" && evt.data.errno) {
      upstreamError = evt.data;
    }
  }
  if (upstreamError && !text) {
    const msg = upstreamError.message || upstreamError.errMsg || upstreamError.errstr || "upstream error";
    const e = new Error(msg);
    e.upstream = upstreamError;
    throw e;
  }
  return { text, reason, upstreamChatId };
}

// 单片发送：原地重试 1 次，再换设备重试，最多 3 台。
// 长文本切片最容易撞上"伪成功"限流，只原地重试会让整条链拖到超时。
async function sendTurnWithDeviceRetry(env, commonParams, secret, args, { onEvent, index = 0, pickDevice } = {}) {
  const tried = [];
  let lastError = null;

  for (let deviceTry = 0; deviceTry < 3; deviceTry++) {
    // 第一片用当前设备；后续失败换设备（commonParams.token 需要跟着换）
    let params = commonParams;
    let sec = secret;
    if (deviceTry > 0 && typeof pickDevice === "function") {
      try {
        const cred = await pickDevice(tried);
        if (cred) {
          tried.push(cred.sn);
          const token = await loginFor(env, cred);
          params = { ...commonParams, token, sn: cred.sn };
          sec = cred.secret;
        }
      } catch (e) {
        onEvent && onEvent("pick-fail", { index, error: String(e && e.message) });
      }
    }

    // 同一台最多原地重试 1 次
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await sendTurn(env, params, sec, args);
        if (typeof pickDevice === "function" && deviceTry > 0) {
          try { await markSuccess(env, params.sn); } catch {}
        }
        return res;
      } catch (e) {
        lastError = e;
        const msg = String((e && e.message) || "");
        // 两种都属于"这台设备不能用了"：
        //   1. 配额耗尽 4001（今日次数已用完）
        //   2. 不透明成功包（限流）
        const quota = /今日次数已用完|次数已用完|code["':\s]+4001/.test(msg);
        const opaque = /^success$/i.test(msg.trim()) || /opaque|rate limit/i.test(msg);
        const transient = quota || opaque;
        onEvent && onEvent("retry", { index, deviceTry, attempt, message: msg.slice(0, 60), transient, quota });
        if (!transient) throw e;
        // 配额耗尽不等待，直接换设备；限流先等 1 秒
        if (quota) break;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (typeof pickDevice === "function") {
      const m = String((lastError && lastError.message) || "");
      const quota = /今日次数已用完|次数已用完/.test(m);
      try { await markFailure(env, params.sn, quota ? "chunk quota exhausted" : "chunk opaque failure", { quotaExhausted: quota }); } catch {}
    }
  }
  throw lastError || new Error("chunk failed after device retries");
}

// 取设备的登录 token（带缓存，重复调用不额外登录）
async function loginFor(env, cred) {
  const { login } = await import("./upstream.js");
  const { getCachedToken, setCachedToken } = await import("./history.js");
  const cached = await getCachedToken(env, cred.sn, cred.secret);
  if (cached) return cached;
  const token = await login(env, cred);
  try { await setCachedToken(env, cred.sn, cred.secret, token); } catch {}
  return token;
}

async function sendTurnWithRetry(env, commonParams, secret, args, { retries = 0, onEvent, index = 0 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await sendTurn(env, commonParams, secret, args);
    } catch (e) {
      lastError = e;
      const msg = String((e && e.message) || "");
      // Only the opaque {"message":"success"} payload is retried; real errors
      // (invalid sig, length, notAllow) fail fast.
      const transient = /^success$/i.test(msg.trim());
      if (typeof onEvent === "function") {
        try {
          onEvent("retry", { index, attempt, message: e.message, transient: !!transient });
        } catch {
          // ignore listener failures
        }
      }
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * 2 ** attempt));
    }
  }
  throw lastError;
}

// Run a long message through the chunked pipeline and return the final answer.
//
// Returns { text, reason, chatId, chunks, truncated, transcript, sentText }.
export async function runLongMessage(
  env,
  commonParams,
  secret,
  {
    chatId,
    content,
    model,
    kind,
    persona = null,
    budget = CHUNK_BYTES,
    maxChunks = MAX_CHUNKS,
    onEvent,
    // 切片级换设备：长文本最容易撞限流，每片失败应换一台
    pickDevice = null,
    deadlineMs = 0,
    startedAt = Date.now(),
    env: envRef = env,
  }
) {
  // Reserve room for the persona directive: the first chunk carries it, the last
  // one carries the stitching instruction, so both are shrunk a little.
  const head = personaBytes(persona);
  // First piece keeps the directive; shrink the overall budget by its size.
  const plan = planChunks(content, Math.max(200, budget - head), maxChunks);
  const transcript = [];
  let upstreamChatId = chatId;
  let answer = "";
  let reason = "";
  let sentText = "";

  const emit = (type, payload) => {
    if (typeof onEvent === "function") {
      try {
        onEvent(type, payload);
      } catch {
        // listener errors must not break the upstream conversation
      }
    }
  };

  emit("plan", { chunks: plan.chunks, truncated: plan.truncated, oversize: plan.oversize, bytes: plan.bytes });

  // 关键：人设帧/工具清单必须作为独立的"前置轮"发送，不能跟着切片走。
  // 之前把 persona 拼进第 0 片，切散后最后一片（承载问题）就看不到设定了，
  // 模型会退回默认人格并答非所问。
  const prefixText = persona && persona.text ? persona.text : "";


  const pieces = plan.pieces.map((raw, i) => {
    const isLast = i === plan.pieces.length - 1;
    let piece = raw;
    if (isLast) {
      // 前面所有片都是背景（项目代码、工具定义等），模型容易把最后一片也当背景，
      // 从而"接着聊背景"而不是回答当前问题。显式加标记把它拎出来。
      const lead = "【当前用户请求 · 请直接回答这条，不要讨论上文背景】\n";
      const tail = continuationInstruction(i, plan.pieces.length);
      const room = MESSAGE_BYTE_LIMIT - byteLength(lead) - byteLength(tail) - 8;
      // 标记可能让超长提问再超限，先按剩余预算裁正文
      let bodyText = piece;
      while (byteLength(bodyText) > room && bodyText.length > 1) {
        bodyText = bodyText.slice(0, -1);
      }
      piece = `${lead}${bodyText}\n${tail}`;
    }
    while (byteLength(piece) > MESSAGE_BYTE_LIMIT && piece.length > 1) {
      piece = piece.slice(0, -1);
    }
    return { index: i, isLast, piece };
  });

  const lastIndex = pieces.length - 1;
  const headPieces = pieces.slice(0, lastIndex);
  const lastPiece = pieces[lastIndex];

  // 第 0 轮：单独发送设定（人设 + 工具清单），让后续所有片都活在这个设定下
  if (prefixText) {
    try {
      const warm = await sendTurnWithDeviceRetry(env, commonParams, secret, {
        chatId: upstreamChatId,
        content: prefixText.slice(0, MESSAGE_BYTE_LIMIT - 10),
        model,
        kind,
      }, { onEvent: emit, index: -1, pickDevice });
      if (warm.upstreamChatId) upstreamChatId = warm.upstreamChatId;
      emit("prefix", { bytes: byteLength(prefixText) });
    } catch (e) {
      emit("prefix-failed", { message: String(e && e.message).slice(0, 80) });
    }
  }

  // 并发发送前置片：每批 CONCURRENCY 片，失败只跳过该片
  const CONCURRENCY = 3;
  for (let i = 0; i < headPieces.length; i += CONCURRENCY) {
    if (deadlineMs && Date.now() - startedAt > deadlineMs) {
      emit("deadline", { index: i, total: pieces.length, elapsed: Date.now() - startedAt });
      break;
    }
    const batch = headPieces.slice(i, i + CONCURRENCY);
    const t0 = Date.now();

    // 注：曾尝试"同一批分散到不同设备"，实测反而更差——
    // 上游的限流是按账号池整体计，多设备并发只会更快打满（132 次重试 vs 88 次）。
    // 所以这里统一用当前设备，失败后由 sendTurnWithDeviceRetry 内部换设备。
    const results = await Promise.all(
      batch.map(async ({ index, piece }) => {
        try {
          const turn = await sendTurnWithDeviceRetry(env, commonParams, secret, {
            chatId: upstreamChatId,
            content: piece,
            model,
            kind,
          }, { onEvent: emit, index, pickDevice });
          return { index, piece, turn, ok: true };
        } catch (e) {
          emit("chunk-failed", { index, message: String(e && e.message).slice(0, 80) });
          return { index, piece, ok: false };
        }
      })
    );
    for (const r of results) {
      if (!r.ok) continue;
      const turn = r.turn;
      if (turn.upstreamChatId) upstreamChatId = turn.upstreamChatId;
      transcript.push({ index: r.index, role: "user", content: r.piece, reply: turn.text });
      emit("chunk", { index: r.index, total: pieces.length, reply: turn.text });
    }
    emit("batch-ms", { from: i, count: batch.length, ms: Date.now() - t0 });
  }

  // 最后一片：单独发送，它的回答就是最终答案
  if (lastPiece) {
    const enoughBudget = !deadlineMs || Date.now() - startedAt <= deadlineMs;
    if (enoughBudget) {
      const t0 = Date.now();
      try {
        const turn = await sendTurnWithDeviceRetry(env, commonParams, secret, {
          chatId: upstreamChatId,
          content: lastPiece.piece,
          model,
          kind,
        }, { onEvent: emit, index: lastPiece.index, pickDevice });
        emit("chunk-ms", { index: lastPiece.index, ms: Date.now() - t0 });
        upstreamChatId = turn.upstreamChatId || upstreamChatId;
        transcript.push({ index: lastPiece.index, role: "user", content: lastPiece.piece, reply: turn.text });
        emit("chunk", { index: lastPiece.index, total: pieces.length, reply: turn.text });
        answer = turn.text;
        reason = turn.reason || "";
        sentText = lastPiece.piece;
      } catch (e) {
        emit("chunk-failed", { index: lastPiece.index, message: String(e && e.message).slice(0, 80) });
      }
    } else {
      emit("deadline", { index: lastPiece.index, total: pieces.length, elapsed: Date.now() - startedAt });
    }
  }

  // 兜底：所有片都失败时，至少返回已收集到的最后一条有效回答
  if (!answer && transcript.length > 0) {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const rep = transcript[i].reply;
      if (rep && rep.trim()) { answer = rep; reason = ""; break; }
    }
  }
  if (!answer) {
    answer = "（内容过长，上游未能完成处理。请缩短输入后重试。）";
  }

  // Close the loop: record the answer as an assistant turn so the thread is
  // self-consistent and later requests do not replay the whole task again.
  if (answer) {
    try {
      await sendTurn(env, commonParams, secret, {
        chatId: upstreamChatId,
        content: answer,
        model,
        kind,
        role: "assistant",
      });
    } catch (err) {
      // 收尾动作失败不影响用户拿到的回答，不当作错误上报
      if (String(err && err.message).includes("格式错误")) {
        // 上游对某些回答内容格式敏感，属预期内
      } else {
        console.error("[chunk] assistant turn write failed: " + (err && err.message ? err.message : err));
      }
    }
  }

  return {
    text: answer,
    reason,
    chatId: upstreamChatId,
    chunks: plan.chunks,
    truncated: plan.truncated,
    oversize: plan.oversize,
    transcript,
    sentText,
  };
}

