// Conversation memory that survives device rotation.
//
// Upstream keeps a thread's state keyed by (device sn, chatId). When the pool
// rotates to another device, that device has never seen the chatId — the client
// gets a stranger who "forgot everything".
//
// This module keeps a compact transcript per chatId in KV and rehydrates a new
// device by replaying it:
//
//   mem:<chatId> = {
//     sn,                 // device that currently holds the thread
//     turns: [[role, content], ...],   // capped, oldest dropped first
//     updated
//   }
//
// On a device change, `ensureThread` replays the stored turns into the new
// device's thread before the live turn is sent. The transcript is also what the
// client sees in OpenAI message history, so the two stay consistent.

import { del, getJSON, putJSON } from "./store.js";
import { sendChatTurn } from "./upstream.js";
import { MESSAGE_BYTE_LIMIT, byteLength } from "./chunk.js";

const PREFIX = "mem:";
// Keep the rehydration cheap: bounded turns and bounded bytes per turn.
const MAX_TURNS = 24;
// Rehydration is latency-sensitive: replay only what is needed for continuity.
const REPLAY_TURNS = 8;
const MAX_TURN_BYTES = 900;
const TTL = 60 * 60 * 24 * 7;

function key(chatId) {
  return PREFIX + chatId;
}

// 按"会话种子"索引的设备绑定记录。chatId 本身含 sn 前缀，路由层在选设备前
// 还不知道 sn，所以单独用种子算一个键来记住"这个会话归哪台设备"。
const BINDING_PREFIX = "mem:bind:";

export function bindingKey(seed) {
  // 简单稳定的 32 位哈希，避免把整段正文塞进 KV 键
  let h = 5381;
  const str = String(seed || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return BINDING_PREFIX + h.toString(36);
}

export async function getBinding(env, seed) {
  if (!seed) return "";
  const rec = await getJSON(env, bindingKey(seed), null);
  if (!rec || !rec.sn) return "";
  // 绑定失效：设备已从池里删除，或已停用/失效/额度耗尽 —— 直接丢弃绑定，
  // 让调用方重新选设备，否则会一直往一台不存在的设备上打。
  const pool = await getJSON(env, "sn:" + rec.sn, null);
  if (!pool || pool.status === "disabled" || pool.status === "dead") {
    try {
      await del(env, bindingKey(seed));
    } catch {
      // ignore
    }
    return "";
  }
  const now = Date.now();
  if (pool.cooldownUntil && now < pool.cooldownUntil && !pool.quotaExhaustedAt) return "";
  if (pool.quotaExhaustedAt) {
    const d1 = new Date(pool.quotaExhaustedAt);
    const d2 = new Date(now);
    if (d1.toDateString() === d2.toDateString()) return "";
  }
  return rec.sn;
}

export async function setBinding(env, seed, sn) {
  if (!seed || !sn) return;
  await putJSON(env, bindingKey(seed), { sn, updated: Date.now() }, 60 * 60 * 24 * 30);
}

export async function loadMemory(env, chatId) {
  if (!chatId) return null;
  return getJSON(env, key(chatId), null);
}

export async function saveMemory(env, chatId, { sn, turns }) {
  if (!chatId) return;
  const trimmed = (turns || [])
    .filter((t) => t && t[0] && t[1])
    .map(([role, content]) => {
      let text = String(content);
      while (byteLength(text) > MAX_TURN_BYTES && text.length > 1) {
        text = text.slice(0, Math.floor(text.length * 0.9));
      }
      return [role, text];
    })
    .slice(-MAX_TURNS);
  await putJSON(env, key(chatId), { sn, turns: trimmed, updated: Date.now() }, TTL);
}

// Append one turn to the stored transcript.
export async function appendTurn(env, chatId, sn, role, content) {
  const mem = (await loadMemory(env, chatId)) || { sn, turns: [] };
  const turns = [...(mem.turns || []), [role, content]].slice(-MAX_TURNS);
  await saveMemory(env, chatId, { sn, turns });
}

// Rehydrate `chatId` on `sn` if the stored thread belongs to another device.
// Returns { replayed: n } — 0 when nothing was needed.
export async function ensureThread(env, commonParams, secret, { chatId, sn, model, kind, turns }) {
  const mem = await loadMemory(env, chatId);
  if (!mem) {
    // First time we see this thread: remember which device owns it.
    if (turns && turns.length) await saveMemory(env, chatId, { sn, turns });
    return { replayed: 0 };
  }
  if (mem.sn === sn) return { replayed: 0 };

  // Device changed: replay the transcript so the new device has the context.
  let replayed = 0;
  const replaySource = (mem.turns || []).slice(-REPLAY_TURNS);
  for (const [role, content] of replaySource) {
    let text = String(content || "");
    if (!text) continue;
    while (byteLength(text) > MESSAGE_BYTE_LIMIT - 4 && text.length > 1) {
      text = text.slice(0, Math.floor(text.length * 0.9));
    }
    try {
      const res = await sendChatTurn(env, commonParams, secret, {
        chatId,
        content: text,
        model,
        role: role === "assistant" ? "assistant" : "user",
        kind,
      });
      await res.text();
      replayed++;
    } catch (err) {
      console.error("[memory] replay failed: " + (err && err.message ? err.message : err));
      break;
    }
  }
  const merged = (turns && turns.length ? turns : mem.turns) || [];
  await saveMemory(env, chatId, { sn, turns: merged });
  return { replayed, movedFrom: mem.sn };
}
