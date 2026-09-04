import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tools } from "../src/tools.js";
import { NAMES, MANIFEST } from "../src/manifest.js";
import { parseCsv, orderOldestFirst } from "../src/bars.js";

const bars = Array.from({ length: 300 }, (_, i) => {
  const base = 100 + i * 0.3 + Math.sin(i / 9) * 5;
  return { o: base, h: base + 1.5, l: base - 1.4, c: base + 0.5, v: 10000 + i };
});

test("the manifest sees every export", () => {
  assert.equal(NAMES.length, 89);
  for (const e of MANIFEST.values()) {
    assert.ok(["bars", "series", "pair"].includes(e.input), `${e.name} input`);
    assert.notEqual(e.output, "unknown", `${e.name} did not compute on probe bars`);
  }
});

const benchmark = bars.map((b, i) => b.c * 0.8 + Math.cos(i / 11) * 3);

test("every indicator computes through the tool layer", async () => {
  const failures = [];
  for (const name of NAMES) {
    try {
      const r = await tools.compute({ indicator: name, bars, benchmark, tail: 3 });
      assert.ok(r.values, name);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("params are passed positionally and change the result", async () => {
  const a = await tools.compute({ indicator: "rsi", bars, params: { n: 14 }, tail: 1 });
  const b = await tools.compute({ indicator: "rsi", bars, params: { n: 21 }, tail: 1 });
  assert.notEqual(a.values[0], b.values[0]);
});

test("a later param alone keeps the earlier defaults", async () => {
  const withDefault = await tools.compute({ indicator: "bollinger", bars, tail: 1 });
  const wider = await tools.compute({ indicator: "bollinger", bars, params: { mult: 3 }, tail: 1 });
  assert.equal(withDefault.values.mid[0], wider.values.mid[0]);
  assert.ok(wider.values.upper[0] > withDefault.values.upper[0]);
});

test("an unknown parameter is refused, not ignored", async () => {
  await assert.rejects(
    () => tools.compute({ indicator: "rsi", bars, params: { period: 21 } }),
    /has no parameter `period`/
  );
});

test("an unknown indicator suggests a real one", async () => {
  await assert.rejects(() => tools.compute({ indicator: "bollingerbands", bars }), /bollinger/);
});

test("multi-line indicators come back as named arrays", async () => {
  const r = await tools.compute({ indicator: "macd", bars, tail: 5 });
  assert.deepEqual(Object.keys(r.values), ["line", "signal", "hist"]);
  assert.equal(r.values.line.length, 5);
  assert.ok(Number.isInteger(r.summary.line.warmup));
});

test("closes-only input drives a close-based indicator", async () => {
  const r = await tools.compute({ indicator: "sma", bars: bars.map((b) => b.c), params: { n: 20 }, tail: 1 });
  assert.ok(Math.abs(r.values[0] - bars.slice(-20).reduce((s, b) => s + b.c, 0) / 20) < 1e-6);
});

test("compute_many reads the bars once", async () => {
  const r = await tools.compute_many({ indicators: ["rsi", { indicator: "ema", params: { n: 50 } }, "nope"], bars, tail: 2 });
  assert.equal(r.results.length, 2);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /unknown indicator/);
});

test("csv columns are matched by alias, close beating adj close", () => {
  const { bars: got, columns } = parseCsv(
    "Date,Open,High,Low,Close,Adj Close,Volume\n2024-01-01,10,12,9,11,10.8,1000\n2024-01-02,11,13,10,12,11.9,1100\n"
  );
  assert.equal(columns.c, "Close");
  assert.equal(got.length, 2);
  assert.deepEqual({ o: got[0].o, h: got[0].h, l: got[0].l, c: got[0].c, v: got[0].v }, { o: 10, h: 12, l: 9, c: 11, v: 1000 });
});

test("newest-first csv is reversed when the dates say so", () => {
  const { bars: got } = parseCsv("date,close\n2024-03-01,30\n2024-02-01,20\n2024-01-01,10\n");
  const ordered = orderOldestFirst(got);
  assert.equal(ordered.reversed, true);
  assert.equal(ordered.bars[0].c, 10);
  assert.equal(ordered.bars[2].c, 30);
});

test("a csv without a close says so plainly", () => {
  assert.throws(() => parseCsv("date,price\n2024-01-01,10\n"), /no close column found/);
});

test("a file on disk computes end to end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "indicato-"));
  const path = join(dir, "bars.csv");
  await writeFile(path, "date,open,high,low,close,volume\n" +
    bars.map((b, i) => `2024-01-${String((i % 28) + 1).padStart(2, "0")},${b.o},${b.h},${b.l},${b.c},${b.v}`).join("\n"));
  const r = await tools.compute({ indicator: "atr", file: path, tail: 1 });
  assert.equal(r.source.rows, 300);
  assert.equal(r.source.columns.c, "close");
  assert.ok(r.values[0] > 0);
});

test("the tail is the default, not the whole series", async () => {
  const r = await tools.compute({ indicator: "sma", bars, params: { n: 5 } });
  assert.equal(r.values.length, 10);
  assert.equal(r.summary.defined, 296);
  const all = await tools.compute({ indicator: "sma", bars, params: { n: 5 }, full: true });
  assert.equal(all.values.length, 300);
});

test("a two-series indicator asks for a benchmark rather than crashing", async () => {
  await assert.rejects(
    () => tools.compute({ indicator: "beta", bars }),
    /compares two series/
  );
});

test("a misaligned benchmark is refused", async () => {
  await assert.rejects(
    () => tools.compute({ indicator: "beta", bars, benchmark: benchmark.slice(0, 50) }),
    /aligned bar for bar/
  );
});

test("beta against a benchmark is around one for a scaled copy", async () => {
  const scaled = bars.map((b) => b.c * 2);
  const r = await tools.compute({ indicator: "beta", bars, benchmark: scaled, params: { n: 30 }, tail: 1 });
  assert.ok(Math.abs(r.values[0] - 0.5) < 1e-6, `beta was ${r.values[0]}`);
});
