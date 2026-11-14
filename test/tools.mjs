// 工具调用模拟层测试：node test/tools.mjs
import assert from "node:assert";
const T = await import("../src/tools.js");

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + " — " + e.message); process.exitCode = 1; }
};

const TOOLS = [{
  type: "function",
  function: {
    name: "run_shell",
    description: "在本机执行 shell 命令",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
}];

console.log("tools.js");
t("识别 tools 字段", () => {
  assert.equal(T.hasTools({ tools: TOOLS }), true);
  assert.equal(T.hasTools({}), false);
  assert.equal(T.hasTools({ tools: [] }), false);
});
t("格式对齐提示在字节预算内且不含工具清单", () => {
  const p = T.buildAdapterHint("auto");
  const bytes = new TextEncoder().encode(p).length;
  assert.ok(bytes < 200, "hint too long: " + bytes);
  assert.ok(p.includes("<tool_call>"));
  // 代理不再罗列工具定义：工具清单归 agent 注入
  assert.ok(!p.includes("run_shell"));
});
t("标准块解析", () => {
  const c = T.parseToolCalls('<tool_call>{"name":"run_shell","arguments":{"command":"uptime"}}</tool_call>', ["run_shell"]);
  assert.equal(c.length, 1);
  assert.equal(c[0].function.name, "run_shell");
  assert.deepEqual(JSON.parse(c[0].function.arguments), { command: "uptime" });
});
t("容错变体解析", () => {
  const v1 = 'tool_call: {"name":"run_shell","arguments":{"command":"ls"}}';
  const v2 = '{"name":"run_shell","arguments":{"command":"ls"}}';
  assert.equal(T.parseToolCalls(v1, ["run_shell"]).length, 1);
  assert.equal(T.parseToolCalls(v2, ["run_shell"]).length, 1);
});
t("忽略未声明的工具名", () => {
  const c = T.parseToolCalls('{"name":"rm_rf","arguments":{}}', ["run_shell"]);
  assert.equal(c.length, 0);
});
t("工具结果按字节截断", () => {
  const long = "甲".repeat(500);
  const out = T.trimByBytes(long, 300);
  assert.ok(new TextEncoder().encode(out).length <= 320);
  assert.ok(out.includes("truncated"));
});
t("role:tool 折成文本", () => {
  const msgs = T.renderToolResults([{ role: "tool", tool_call_id: "c1", content: "ok" }]);
  assert.equal(msgs[0].role, "user");
  assert.ok(msgs[0].content.includes("[工具结果"));
});
t("参数校验：合法调用", () => {
  const SCHEMA = { run_shell: { parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } };
  const c = T.parseToolCalls('<tool_call>{"name":"run_shell","arguments":{"command":"date"}}</tool_call>', ["run_shell"], SCHEMA);
  assert.equal(c.length, 1);
  assert.equal(c.rejected.length, 0);
});
t("参数校验：缺必填参数被拒", () => {
  const SCHEMA = { run_shell: { parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } };
  const c = T.parseToolCalls('<tool_call>{"name":"run_shell","arguments":{}}</tool_call>', ["run_shell"], SCHEMA);
  assert.equal(c.length, 0);
  assert.equal(c.rejected.length, 1);
  assert.ok(c.rejected[0].errors[0].includes("command"));
});
t("参数校验：类型不符被拒", () => {
  const SCHEMA = { run_shell: { parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } };
  const c = T.parseToolCalls('<tool_call>{"name":"run_shell","arguments":{"command":123}}</tool_call>', ["run_shell"], SCHEMA);
  assert.equal(c.length, 0);
  assert.ok(c.rejected[0].errors[0].includes("should be string"));
});
t("toolCallPayload 剥离协议块", () => {
  const p = T.toolCallPayload('先查一下<tool_call>{"name":"run_shell","arguments":{}}</tool_call>', [{ id: "1" }]);
  assert.equal(p.content, "先查一下");
  assert.equal(p.tool_calls.length, 1);
});

console.log("\n" + pass + " 项通过");
