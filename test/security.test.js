import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createServer, MAX_CONCURRENT, MAX_LINE_BYTES } from "../src/rpc.js";
import { parseCsv, setAllowedRoot } from "../src/bars.js";
import { tools, MAX_INDICATORS, MAX_WINDOW } from "../src/tools.js";
import { DEFINITIONS } from "../src/server.js";

const BIN = fileURLToPath(new URL("../src/server.js", import.meta.url));

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "security-test", version: "0" },
  },
};

const SAMPLE_BARS = Array.from({ length: 60 }, (_, i) => ({
  o: 100 + i,
  h: 102 + i,
  l: 99 + i,
  c: 101 + i,
  v: 1000 + i,
}));

function sampleCsv() {
  const rows = ["Date,Open,High,Low,Close,Volume"];
  for (let i = 0; i < 40; i++) {
    const d = String((i % 28) + 1).padStart(2, "0");
    rows.push(`2025-01-${d},${100 + i},${102 + i},${99 + i},${101 + i},1000`);
  }
  return rows.join("\n") + "\n";
}

function talk(messages, { args = [], env = process.env, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out"));
    }, timeout);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = out.split("\n").filter((l) => l.trim());
      const responses = lines.map((l) => JSON.parse(l));
      resolve({ responses, stderr: err, code });
    });
    child.on("error", reject);
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
    child.stdin.end();
  });
}

/* ---- 1. Prototype-safe tool lookup & RPC argument guards ------------------------- */

test("tools/call rejects Object.prototype property names with -32601", async () => {
  const protoNames = ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"];
  const calls = protoNames.map((name, idx) => ({
    jsonrpc: "2.0",
    id: idx + 2,
    method: "tools/call",
    params: { name, arguments: {} },
  }));
  const { responses } = await talk([INIT, ...calls]);
  for (let i = 0; i < protoNames.length; i++) {
    const res = responses.find((r) => r.id === i + 2);
    assert.ok(res?.error, `expected JSON-RPC error for ${protoNames[i]}`);
    assert.equal(res.error.code, -32601, protoNames[i]);
  }
});

test("tools/call rejects non-object arguments cleanly", async () => {
  const { responses } = await talk([
    INIT,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_indicators", arguments: ["bad"] } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: 123, arguments: {} } },
  ]);
  assert.equal(responses.find((r) => r.id === 2).error.code, -32600);
  assert.equal(responses.find((r) => r.id === 3).error.code, -32601);
});

/* ---- 2. Sensitive file & extension guards ---------------------------------------- */

test("sensitive dotfiles, keys, system files and non-tabular extensions are refused without leaking content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "indicato-sec-files-"));
  const secretMarker = "SUPER_SECRET_KEY_MATERIAL_987654321";

  const envFile = join(dir, ".env");
  const envJson = join(dir, ".env.json");
  const idRsa = join(dir, "id_rsa");
  const pemFile = join(dir, "cert.pem");
  const sqliteFile = join(dir, "store.sqlite");
  const sshDir = join(dir, ".ssh");
  await mkdir(sshDir);
  const sshKeyCsv = join(sshDir, "bars.csv");
  const configDir = join(dir, ".config");
  await mkdir(configDir);
  const gcloudCreds = join(configDir, "application_default_credentials.json");
  const symlinkToSecret = join(dir, "prices.csv");

  await writeFile(envFile, `API_KEY=${secretMarker}\n`);
  await writeFile(envJson, JSON.stringify({ secret: secretMarker }));
  await writeFile(idRsa, `-----BEGIN OPENSSH PRIVATE KEY-----\n${secretMarker}\n`);
  await writeFile(pemFile, `-----BEGIN PRIVATE KEY-----\n${secretMarker}\n`);
  await writeFile(sqliteFile, `SQLite format 3\0${secretMarker}`);
  await writeFile(sshKeyCsv, sampleCsv());
  await writeFile(gcloudCreds, JSON.stringify({ client_secret: secretMarker }));
  await symlink(idRsa, symlinkToSecret);

  const blocked = [
    envFile,
    envJson,
    idRsa,
    pemFile,
    sqliteFile,
    sshKeyCsv,
    gcloudCreds,
    symlinkToSecret,
    "/etc/passwd",
    "/proc/self/environ",
    `${dir}/bars.csv\0.txt`,
  ];

  for (const target of blocked) {
    await assert.rejects(
      () => tools.compute({ indicator: "rsi", file: target }),
      (err) => {
        assert.ok(!err.message.includes(secretMarker), `leaked secret for ${target}`);
        assert.ok(!err.message.includes("BEGIN OPENSSH"), `leaked key header for ${target}`);
        assert.ok(!err.message.includes("root:"), `leaked passwd content for ${target}`);
        return true;
      },
      `expected ${target} to be rejected`
    );
  }
});

test("malformed JSON or INI content starting with '[' in a .txt file never quotes file content back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "indicato-sec-ini-"));
  const ini = join(dir, "creds.txt");
  const marker = "AKIA_SECRET_TOKEN_VALUE_12345";
  await writeFile(ini, `[default]\naws_secret_access_key = ${marker}\n`);

  await assert.rejects(
    () => tools.compute({ indicator: "rsi", file: ini }),
    (err) => {
      assert.match(err.message, /invalid JSON/);
      assert.ok(!err.message.includes(marker), "leaked INI secret");
      assert.ok(!err.message.includes("aws_secret"), "leaked INI key name");
      return true;
    }
  );
});

test("supported .csv, .tsv, .txt and .json extensions continue to load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "indicato-sec-ok-"));
  const tsv = join(dir, "bars.tsv");
  const txt = join(dir, "bars.TXT");
  const json = join(dir, "bars.JSON");

  await writeFile(tsv, sampleCsv().replace(/,/g, "\t"));
  await writeFile(txt, sampleCsv());
  await writeFile(json, JSON.stringify(SAMPLE_BARS));

  for (const file of [tsv, txt, json]) {
    const r = await tools.compute({ indicator: "rsi", file, tail: 2 });
    assert.equal(r.values.length, 2);
  }
});

/* ---- 3. Root confinement (--root and INDICATO_ROOT) & benchmarkFile schema ------- */

test("INDICATO_ROOT and setAllowedRoot block ../, sibling-prefix paths and symlink escapes", async () => {
  const base = await mkdtemp(join(tmpdir(), "indicato-root-base-"));
  const root = join(base, "allowed");
  const sibling = join(base, "allowed-other");
  await mkdir(root);
  await mkdir(sibling);

  const goodCsv = join(root, "reliance.csv");
  const outsideCsv = join(sibling, "secret.csv");
  const escapeLink = join(root, "escape.csv");
  await writeFile(goodCsv, sampleCsv());
  await writeFile(outsideCsv, sampleCsv());
  await symlink(outsideCsv, escapeLink);

  setAllowedRoot(root);
  try {
    const ok = await tools.compute({ indicator: "rsi", file: "reliance.csv", tail: 1 });
    assert.equal(ok.values.length, 1);

    await assert.rejects(
      () => tools.compute({ indicator: "rsi", file: "../allowed-other/secret.csv" }),
      /outside the allowed root/
    );
    await assert.rejects(
      () => tools.compute({ indicator: "rsi", file: outsideCsv }),
      /outside the allowed root/
    );
    await assert.rejects(
      () => tools.compute({ indicator: "rsi", file: escapeLink }),
      /escapes the allowed root/
    );
    await assert.rejects(
      () => tools.compute({ indicator: "beta", file: goodCsv, benchmarkFile: escapeLink }),
      /escapes the allowed root/
    );
  } finally {
    setAllowedRoot(null);
  }

  const prevEnv = process.env.INDICATO_ROOT;
  process.env.INDICATO_ROOT = root;
  try {
    const ok = await tools.compute({ indicator: "rsi", file: goodCsv, tail: 1 });
    assert.equal(ok.values.length, 1);
    await assert.rejects(
      () => tools.compute({ indicator: "rsi", file: escapeLink }),
      /escapes the allowed root/
    );
  } finally {
    if (prevEnv === undefined) delete process.env.INDICATO_ROOT;
    else process.env.INDICATO_ROOT = prevEnv;
  }
});

test("CLI --root confines file access over stdio JSON-RPC", async () => {
  const base = await mkdtemp(join(tmpdir(), "indicato-cli-root-"));
  const root = join(base, "exports");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);

  const insideFile = join(root, "ok.csv");
  const outsideFile = join(outside, "nope.csv");
  const linkFile = join(root, "link.csv");
  await writeFile(insideFile, sampleCsv());
  await writeFile(outsideFile, sampleCsv());
  await symlink(outsideFile, linkFile);

  const { responses } = await talk(
    [
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "compute", arguments: { indicator: "rsi", file: insideFile, tail: 1 } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "compute", arguments: { indicator: "rsi", file: "../outside/nope.csv", tail: 1 } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "compute", arguments: { indicator: "rsi", file: linkFile, tail: 1 } } },
    ],
    { args: ["--root", root] }
  );

  assert.ok(!responses.find((r) => r.id === 2).result.isError);
  const r3 = responses.find((r) => r.id === 3).result;
  assert.equal(r3.isError, true);
  assert.match(r3.content[0].text, /outside the allowed root/);

  const r4 = responses.find((r) => r.id === 4).result;
  assert.equal(r4.isError, true);
  assert.match(r4.content[0].text, /escapes the allowed root/);
});

test("compute and compute_many schemas document benchmark and benchmarkFile", () => {
  for (const toolName of ["compute", "compute_many"]) {
    const def = DEFINITIONS.find((d) => d.name === toolName);
    assert.ok(def.inputSchema.properties.benchmark, `${toolName}.benchmark`);
    assert.equal(def.inputSchema.properties.benchmarkFile.type, "string", `${toolName}.benchmarkFile`);
  }
});

/* ---- 4. Tight column matching & header/date redaction ---------------------------- */

test("short aliases do not substring-match unrelated words or secret lines", () => {
  assert.throws(() => parseCsv("width,holiday,revolving\n10,20,30\n"), /no close column found/);
  assert.throws(
    () => parseCsv("API_KEY_LAST=sk-live-secret-token-999999,100\nfoo,200\n"),
    (err) => {
      assert.match(err.message, /no close column found/);
      assert.ok(!err.message.includes("sk-live-secret-token"), "leaked secret in error");
      return true;
    }
  );

  const parsed = parseCsv("Date,Close\nnot-a-date-secret-value-xyz,101.5\n2025-01-02,102.5\n");
  assert.equal(parsed.bars[0].t, undefined);
  assert.equal(parsed.bars[1].t, "2025-01-02");
});

/* ---- 5. Bounded stdin line buffer & bounded concurrency -------------------------- */

test("oversized newline-less stdin chunk is discarded with -32600 and server stays alive", async () => {
  const child = spawn(process.execPath, [BIN], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });

  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("timed out")); }, 15000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on("error", reject);
  });

  /* Stream more than MAX_LINE_BYTES without a newline, then terminate the bad line and
   * send a normal ping to prove the process survived and recovered framing. */
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const count = Math.floor(MAX_LINE_BYTES / chunk.length) + 1;
  for (let i = 0; i < count; i++) {
    if (!child.stdin.write(chunk)) {
      await new Promise((r) => child.stdin.once("drain", r));
    }
  }
  child.stdin.write("\n" + JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }) + "\n");
  child.stdin.end();

  const code = await closed;
  assert.equal(code, 0);
  const responses = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(responses.length, 2);
  assert.equal(responses[0].error.code, -32600);
  assert.deepEqual(responses[1], { jsonrpc: "2.0", id: 99, result: {} });
});

test("concurrent tool executions are capped at maxConcurrent", async () => {
  let active = 0;
  let peak = 0;
  const stream = new PassThrough();
  const output = new PassThrough();
  let rawOut = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { rawOut += chunk; });

  const srv = createServer({
    name: "concurrency-test",
    version: "0",
    definitions: [],
    output,
    maxConcurrent: MAX_CONCURRENT,
    tools: {
      async slow() {
        active++;
        if (active > peak) peak = active;
        await new Promise((r) => setTimeout(r, 15));
        active--;
        return { ok: true };
      },
    },
  });

  const done = srv.listen(stream, { exitOnEnd: false });
  for (let i = 1; i <= 16; i++) {
    stream.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "slow", arguments: {} } }) + "\n");
  }
  stream.end();
  await done;

  const lines = rawOut.split("\n").filter(Boolean);
  assert.equal(lines.length, 16);
  assert.ok(peak <= MAX_CONCURRENT, `peak concurrency ${peak} exceeded ${MAX_CONCURRENT}`);
});

/* ---- 6. CPU & fan-out bounds in compute / compute_many --------------------------- */

test("compute_many caps indicator count and reports full showing accurately", async () => {
  const tooMany = Array.from({ length: MAX_INDICATORS + 1 }, () => "rsi");
  await assert.rejects(
    () => tools.compute_many({ indicators: tooMany, bars: SAMPLE_BARS }),
    new RegExp(`at most ${MAX_INDICATORS}`)
  );
  await assert.rejects(
    () => tools.compute_many({ indicators: [], bars: SAMPLE_BARS }),
    /non-empty array/
  );

  const fullRes = await tools.compute_many({ indicators: ["rsi", "atr"], bars: SAMPLE_BARS, full: true });
  assert.equal(fullRes.showing, `all ${SAMPLE_BARS.length} values`);
});

test("rolling window ceiling and single-letter window guards reject oversized or fractional periods", async () => {
  for (const indicator of ["sma", "median", "linreg", "wma", "alma", "ulcerIndex"]) {
    await assert.rejects(
      () => tools.compute({ indicator, bars: SAMPLE_BARS, params: { n: 1_000_000 } }),
      new RegExp(`beyond the ${MAX_WINDOW} window limit`),
      indicator
    );
  }

  await assert.rejects(
    () => tools.compute({ indicator: "stochastic", bars: SAMPLE_BARS, params: { k: 2.5 } }),
    /window length/
  );
  await assert.rejects(
    () => tools.compute({ indicator: "stochRsi", bars: SAMPLE_BARS, params: { d: 0 } }),
    /window length/
  );
  await assert.rejects(
    () => tools.compute({ indicator: "ultosc", bars: SAMPLE_BARS, params: { m: 1_000_000 } }),
    new RegExp(`beyond the ${MAX_WINDOW} window limit`)
  );
  await assert.rejects(
    () => tools.compute({ indicator: "chandeKrollStop", bars: SAMPLE_BARS, params: { p: -3 } }),
    /window length/
  );
  await assert.rejects(
    () => tools.compute({ indicator: "coppock", bars: SAMPLE_BARS, params: { a: 1.5 } }),
    /window length/
  );
  await assert.rejects(
    () => tools.compute({ indicator: "massIndex", bars: SAMPLE_BARS, params: { e: 0 } }),
    /window length/
  );
  await assert.rejects(
    () => tools.compute({ indicator: "williamsFractals", bars: SAMPLE_BARS, params: { w: 0 } }),
    /window length/
  );
});
