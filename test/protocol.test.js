/* The transport is hand-written, so it is tested as a client sees it: bytes in on
 * stdin, bytes out on stdout, through the real binary. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../src/server.js", import.meta.url));

function talk(messages, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("timed out")); }, timeout);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = out.split("\n").filter((l) => l.trim());
      let parsed;
      try { parsed = lines.map((l) => JSON.parse(l)); }
      catch (e) { return reject(new Error(`stdout was not pure JSON-RPC: ${e.message}\n${out.slice(0, 400)}`)); }
      resolve({ responses: parsed, stderr: err, code });
    });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
    child.stdin.end();
  });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };

test("initialize handshake", async () => {
  const { responses } = await talk([INIT]);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].result.protocolVersion, "2025-06-18");
  assert.equal(responses[0].result.serverInfo.name, "indicato-mcp");
  assert.ok(responses[0].result.capabilities.tools);
});

test("an older client keeps its own protocol version", async () => {
  const { responses } = await talk([{ ...INIT, params: { ...INIT.params, protocolVersion: "2024-11-05" } }]);
  assert.equal(responses[0].result.protocolVersion, "2024-11-05");
});

test("an unknown protocol version is answered with ours", async () => {
  const { responses } = await talk([{ ...INIT, params: { ...INIT.params, protocolVersion: "1999-01-01" } }]);
  assert.equal(responses[0].result.protocolVersion, "2025-06-18");
});

test("tools/list returns four usable tools", async () => {
  const { responses } = await talk([INIT,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  const list = responses.find((r) => r.id === 2).result.tools;
  assert.deepEqual(list.map((t) => t.name).sort(),
    ["compute", "compute_many", "describe_indicator", "list_indicators"]);
  for (const t of list) {
    assert.equal(t.inputSchema.type, "object", `${t.name} schema`);
    assert.ok(t.description.length > 20, `${t.name} description`);
  }
});

test("the initialized notification draws no response", async () => {
  const { responses } = await talk([INIT, { jsonrpc: "2.0", method: "notifications/initialized" }]);
  assert.equal(responses.length, 1);
});

test("an unknown notification is ignored, not answered", async () => {
  const { responses } = await talk([INIT, { jsonrpc: "2.0", method: "notifications/cancelled", params: {} }]);
  assert.equal(responses.length, 1);
});

test("tools/call computes over inline bars", async () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({ o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 1000 }));
  const { responses } = await talk([INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "compute", arguments: { indicator: "sma", bars, params: { n: 10 }, tail: 1 } } }]);
  const r = responses.find((x) => x.id === 2).result;
  assert.ok(!r.isError);
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.indicator, "sma");
  assert.ok(Math.abs(payload.values[0] - 155) < 1e-6, `got ${payload.values[0]}`);
});

test("a tool error comes back as content, not a protocol error", async () => {
  const { responses } = await talk([INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "compute", arguments: { indicator: "nonesuch", bars: [1, 2, 3] } } }]);
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /no indicator named/);
});

test("an unknown tool is a method-not-found error", async () => {
  const { responses } = await talk([INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rm_rf", arguments: {} } }]);
  assert.equal(responses.find((x) => x.id === 2).error.code, -32601);
});

test("an unknown method is refused", async () => {
  const { responses } = await talk([INIT, { jsonrpc: "2.0", id: 2, method: "resources/list" }]);
  assert.equal(responses.find((x) => x.id === 2).error.code, -32601);
});

test("ping answers", async () => {
  const { responses } = await talk([INIT, { jsonrpc: "2.0", id: 2, method: "ping" }]);
  assert.deepEqual(responses.find((x) => x.id === 2).result, {});
});

test("malformed JSON does not kill the server", async () => {
  const child = ["{ not json", JSON.stringify(INIT)].join("\n") + "\n";
  const { responses } = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => resolve({ responses: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
    p.on("error", reject);
    p.stdin.write(child); p.stdin.end();
  });
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[1].result.serverInfo.name, "indicato-mcp");
});

test("messages split across chunk boundaries reassemble", async () => {
  const line = JSON.stringify(INIT) + "\n";
  const { responses } = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => resolve({ responses: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
    p.on("error", reject);
    /* One byte at a time — the pathological case for a line-buffered reader. */
    for (const ch of line) p.stdin.write(ch);
    p.stdin.end();
  });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.serverInfo.name, "indicato-mcp");
});

test("nothing but protocol reaches stdout", async () => {
  const bars = Array.from({ length: 40 }, (_, i) => ({ o: 1, h: 2, l: 0.5, c: 1 + i * 0.01, v: 10 }));
  const { responses, stderr } = await talk([INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "compute_many", arguments: { indicators: ["rsi", "atr", "obv"], bars } } }]);
  assert.equal(responses.length, 2);
  assert.equal(stderr, "");
});
