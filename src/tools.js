// Function-calling shim.
//
// The upstream chat protocol (see src/upstream.js buildChatBody) has no `tools`
// field: it is a reading-companion chat API, not an agent API. So a client that
// sends OpenAI-style `tools` gets nothing back — no `tool_calls`, and the model
// just narrates commands as text.
//
// This module bridges the gap on the proxy side:
//
//   1. 工具定义与调用格式由 agent 自己写进 system prompt —— 代理不负责"教"模型用工具；
//   2. 代理只追加一条格式对齐说明（`buildAdapterHint`），把 agent 的格式收敛到
//      <tool_call>{"name":"run_shell","arguments":{"command":"uptime"}}</tool_call>；
//   3. the model is told to answer with that block when it wants a tool;
//   3. `parseToolCalls(text)` pulls those blocks back out, so the reply can be
//      reshaped into a standard `message.tool_calls` + `finish_reason:"tool_calls"`;
//   4. `renderToolResults(messages)` folds prior `role:"tool"` turns into plain
//      text the upstream model can read.
//
// It is a simulation: reliability depends on the model honouring the format. If
// it narrates instead, the caller sees a normal text answer with no tool_calls.

// 标准写法 <tool_call>{...}</tool_call>；同时容忍模型常见的变体：
//   tool_call: {...}   /   ```tool_call {...} ```   /   [tool_call]{...}[/tool_call]
// 解析策略：先按标准 <tool_call> 块找；找不到就退化为"扫描文本里所有含 name 的 JSON 对象"。
const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

export function hasTools(body) {
  return !!(body && Array.isArray(body.tools) && body.tools.length > 0);
}

function schemaOf(tool) {
  const fn = tool && (tool.function || tool);
  if (!fn || !fn.name) return null;
  return {
    name: fn.name,
    description: fn.description || "",
    parameters: fn.parameters || { type: "object", properties: {} },
  };
}

// 代理不再"教"模型怎么用工具：工具定义与调用格式由 agent 自己注入（system prompt）。
// 代理只负责一件事——把 agent 使用的格式对齐到本代理能解析的格式。
//
// 若 agent 已经写明了自己的 tool_call 格式，代理只追加一句"同时输出下列块"，
// 不改写 agent 的原话；若 agent 没写任何格式，才给出默认约定。

const ADAPTER_HINT = `若你决定调用工具，请额外输出一行：
<tool_call>{"name":"工具名","arguments":{...}}</tool_call>`;

export function buildAdapterHint(toolChoice = "auto") {
  if (toolChoice === "required") {
    return `[格式对齐] 本次必须调用工具。${ADAPTER_HINT}`;
  }
  return `[格式对齐] ${ADAPTER_HINT}`;
}

// Fold role:"tool" messages (and assistant tool_calls) back into plain text.
// 工具结果可能很长（df -h 之类），上游只吃 ~1000 字节，这里按字节截断。
const MAX_TOOL_RESULT_BYTES = 400;
const enc = new TextEncoder();

export function trimByBytes(text, max = MAX_TOOL_RESULT_BYTES) {
  const s = String(text ?? "");
  if (enc.encode(s).length <= max) return s;
  let cut = s.length;
  while (cut > 0 && enc.encode(s.slice(0, cut)).length > max) cut -= Math.max(1, Math.floor(cut / 20));
  return s.slice(0, cut) + "…(truncated)";
}

export function renderToolResults(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || m.role !== "tool") return m;
    const id = m.tool_call_id ? ` #${m.tool_call_id}` : "";
    return { role: "user", content: `[工具结果${id}]\n${trimByBytes(m.content)}` };
  });
}

// Pull <tool_call> blocks out of the model text.
// 校验工具参数是否符合声明的 JSON Schema（只查 required 与基本类型）。
// 返回 { ok } 或 { ok:false, errors:[...] }
export function validateArguments(schema, args) {
  const params = schema && schema.parameters;
  if (!params || typeof params !== "object") return { ok: true };
  const obj = args && typeof args === "object" ? args : {};
  const errors = [];
  for (const key of params.required || []) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === "") {
      errors.push(`missing required argument: ${key}`);
    }
  }
  for (const [key, def] of Object.entries(params.properties || {})) {
    if (obj[key] === undefined) continue;
    const t = def && def.type;
    if (!t) continue;
    const v = obj[key];
    const actual = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
    if (t === "integer" && actual === "number" && Number.isInteger(v)) continue;
    if (t === "number" && actual === "number") continue;
    if (t !== actual) errors.push(`argument \"${key}\" should be ${t}, got ${actual}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function parseToolCalls(text, allowedNames = [], schemas = {}) {
  const src = String(text || "");
  const calls = [];
  const rejected = [];
  const push = (obj) => {
    if (!obj || typeof obj.name !== "string" || !obj.name) return;
    if (allowedNames.length > 0 && !allowedNames.includes(obj.name)) return;
    if (calls.some((c) => c.function.name === obj.name)) return; // 去重
    // 兼容参数平铺在顶层的坏格式：{"name":"run_shell","command":"date"}
    let args = obj.arguments || obj.parameters;
    if (!args || typeof args !== "object") {
      const rest = { ...obj };
      delete rest.name;
      delete rest.arguments;
      delete rest.parameters;
      args = Object.keys(rest).length > 0 ? rest : {};
    }
    // 参数不合 schema 的调用不返回给客户端（否则 agent 会拿 undefined 去执行）
    const schema = schemas[obj.name];
    if (schema) {
      const v = validateArguments(schema, args);
      if (!v.ok) {
        rejected.push({ name: obj.name, arguments: args, errors: v.errors });
        return;
      }
    }
    calls.push({
      id: `call_${Math.random().toString(36).slice(2, 10)}`,
      type: "function",
      function: { name: obj.name, arguments: JSON.stringify(args) },
    });
  };

  // 1) 标准块
  const blockRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let hit = false;
  let m;
  while ((m = blockRe.exec(src)) !== null) {
    hit = true;
    const raw = m[1].trim().replace(/^\`\`\`(?:json)?/i, "").replace(/\`\`\`$/, "").trim();
    try {
      push(JSON.parse(raw));
    } catch {
      try {
        push(JSON.parse(raw.replace(/,\s*}$/, "}")));
      } catch {
        // 忽略坏块
      }
    }
  }
  if (hit) {
    calls.rejected = rejected;
    return calls;
  }

  // 2) 退化：逐个 '{' 尝试做括号配对解析，能解析出含 name 的对象就收下
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < src.length; j++) {
      const ch = src[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const chunk = src.slice(i, j + 1);
          if (chunk.includes('"name"')) {
            try {
              push(JSON.parse(chunk));
            } catch {
              // 不是合法 JSON，跳过
            }
          }
          i = j;
          break;
        }
      }
    }
  }
  return calls;
}


// Strip the tool_call blocks from the visible content.
export function stripToolCalls(text) {
  return String(text || "").replace(TOOL_CALL_RE, "").trim();
}

export function toolCallPayload(text, toolCalls) {
  const content = stripToolCalls(text);
  return {
    role: "assistant",
    content: content.length > 0 ? content : null,
    tool_calls: toolCalls,
  };
}
