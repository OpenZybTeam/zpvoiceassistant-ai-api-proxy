// 极简断言测试：node test/unit.mjs
import assert from "node:assert";

const { splitMessage, planChunks, byteLength, exceedsLimit } = await import("../src/chunk.js");
const { isOpaqueSuccess } = await import("../src/openai.js");
const { healthOf, parseImport, isUsable } = await import("../src/snpool.js");
const { bindingKey } = await import("../src/memory.js");

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log("  ✓ " + name);
  } catch (e) {
    console.error("  ✗ " + name + " — " + e.message);
    process.exitCode = 1;
  }
};

console.log("chunk.js");
t("字节切分不破坏内容", () => {
  const s = "甲".repeat(1200);
  const parts = splitMessage(s);
  assert.equal(parts.join(""), s);
  for (const p of parts) assert.ok(byteLength(p) <= 800, "piece over budget: " + byteLength(p));
});
t("1000 字节边界", () => {
  assert.equal(exceedsLimit("A".repeat(1000)), false);
  assert.equal(exceedsLimit("A".repeat(1001)), true);
  assert.equal(exceedsLimit("中".repeat(333)), false);
  assert.equal(exceedsLimit("中".repeat(334)), true);
});
t("planChunks 不切片短文本", () => {
  const p = planChunks("hello");
  assert.equal(p.chunks, 1);
  assert.equal(p.oversize, false);
});

console.log("openai.js");
t("识别伪成功包", () => {
  assert.equal(isOpaqueSuccess({ code: 200, message: "success", data: null }), true);
  assert.equal(isOpaqueSuccess({ message: "error.invalid.sig" }), false);
  assert.equal(isOpaqueSuccess({ message: "success", data: { x: 1 } }), false);
  assert.equal(isOpaqueSuccess(null), false);
});

console.log("snpool.js");
t("解析批量导入", () => {
  const rows = parseImport("111 aaaa\n# 注释\n222 bbbb 备注\n\n333 cccc");
  assert.equal(rows.length, 3);
  assert.equal(rows[1].note, "备注");
});
t("健康状态推导", () => {
  const now = Date.now();
  assert.equal(healthOf({ status: "active", lastOkAt: now }).key, "ok");
  assert.equal(healthOf({ status: "disabled" }).key, "disabled");
  assert.equal(healthOf({ status: "dead" }).key, "dead");
  assert.equal(healthOf({ status: "active", cooldownUntil: now + 60000 }).key, "cooling");
  assert.equal(
    healthOf({ status: "active", quotaExhaustedAt: now, cooldownUntil: now + 3600000 }).key,
    "quota"
  );
  assert.equal(
    healthOf({ status: "active", failWindow: [now - 1000, now - 2000] }).key,
    "flaky"
  );
});
t("额度耗尽当天不可用（与冷却分离）", () => {
  const now = Date.now();
  assert.equal(isUsable({ sn: "1", secret: "s", status: "active", quotaExhaustedAt: now }), false);
  assert.equal(isUsable({ sn: "1", secret: "s", status: "active", quotaExhaustedAt: now - 86400000 }), true);
});

console.log("memory.js");
t("绑定键稳定", () => {
  assert.equal(bindingKey("abc"), bindingKey("abc"));
  assert.notEqual(bindingKey("abc"), bindingKey("abd"));
});

console.log("\n" + pass + " 项通过");
