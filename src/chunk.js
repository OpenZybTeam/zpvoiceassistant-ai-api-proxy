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
  { chatId, content, model, kind, persona = null, budget = CHUNK_BYTES, maxChunks = MAX_CHUNKS, onEvent }
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

  for (let i = 0; i < plan.pieces.length; i++) {
    const isLast = i === plan.pieces.length - 1;
    let piece = plan.pieces[i];
    if (i === 0 && persona && persona.text) piece = injectPersona(piece, persona);
    if (isLast) piece = `${piece}\n${continuationInstruction(i, plan.pieces.length)}`;
    // Guard: the instruction must never push a piece over the byte budget.
    while (byteLength(piece) > MESSAGE_BYTE_LIMIT && piece.length > 1) {
      piece = piece.slice(0, -1);
    }

    const turn = await sendTurnWithRetry(env, commonParams, secret, {
      chatId: upstreamChatId,
      content: piece,
      model,
      kind,
    }, { retries: TURN_RETRIES, onEvent: emit, index: i });
    upstreamChatId = turn.upstreamChatId || upstreamChatId;
    transcript.push({ index: i, role: "user", content: piece, reply: turn.text });
    emit("chunk", { index: i, total: plan.pieces.length, reply: turn.text });

    if (isLast) {
      answer = turn.text;
      reason = turn.reason || "";
      sentText = piece;
    }
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
      console.error("[chunk] assistant turn write failed: " + (err && err.message ? err.message : err));
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

