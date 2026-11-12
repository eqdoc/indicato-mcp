/* compat: "talib" through the tool layer.
 *
 * The reference is TA-Lib 0.7.1's own output, taken from indicato 0.3.0's compat fixture:
 * 300 bars of RELIANCE and the values TA-Lib returns for each of the nine functions at
 * default parameters. The tool rounds to six places, so the comparison allows 1e-6;
 * indicato's own test holds the library to 1e-12. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tools } from "../src/tools.js";
import { COMPAT_NAMES, MANIFEST } from "../src/manifest.js";

const REF = JSON.parse(readFileSync(new URL("./fixtures/reference.json", import.meta.url), "utf8")).compat;
const bars = REF.bars.map(([o, h, l, c, v]) => ({ o, h, l, c, v }));

const NINE = ["atr", "bollinger", "dmi", "macd", "psar", "rsi", "sma", "stochRsi", "supertrend"];

/* The positional arguments of the fixture, as the names this server takes them by. */
function paramsFor(fn, args) {
  const names = MANIFEST.get(fn).params.map((p) => p.name);
  return Object.fromEntries(args.map((v, i) => [names[i], v]));
}

test("exactly nine indicators have a TA-Lib mode, found from the library's own signatures", () => {
  assert.deepEqual([...COMPAT_NAMES].sort(), NINE);
  assert.deepEqual(REF.cases.map((c) => c.fn).sort(), NINE);
});

for (const c of REF.cases) {
  test(`${c.fn} with compat: "talib" equals TA-Lib on every bar, first value included`, async () => {
    const r = await tools.compute({ indicator: c.fn, bars, params: paramsFor(c.fn, c.args), compat: "talib", full: true });
    assert.equal(r.compat, "talib");
    const got = Array.isArray(r.values) ? { v: r.values } : r.values;
    assert.deepEqual(Object.keys(got).sort(), Object.keys(c.out).map((k) => k).sort().map((k) => k), `${c.fn} lines`);
    let compared = 0;
    for (const [line, want] of Object.entries(c.out)) {
      assert.equal(got[line].length, want.length, `${c.fn}.${line} length`);
      want.forEach((w, i) => {
        if (w === null) return assert.equal(got[line][i], null, `${c.fn}.${line}[${i}] should be null`);
        const g = got[line][i];
        if (typeof w === "boolean") { assert.equal(g, w, `${c.fn}.${line}[${i}]`); compared++; return; }
        assert.ok(g !== null && Math.abs(g - w) <= 1e-6 * Math.max(1, Math.abs(w)), `${c.fn}.${line}[${i}]: ${g} vs ${w}`);
        compared++;
      });
    }
    assert.ok(compared > 100, `${c.fn} compared ${compared} values`);
  });
}

test("compat changes the answer and the warmup: rsi starts one bar later", async () => {
  const a = await tools.compute({ indicator: "rsi", bars, full: true });
  const b = await tools.compute({ indicator: "rsi", bars, compat: "talib", full: true });
  assert.equal(a.summary.warmup, 13);
  assert.equal(b.summary.warmup, 14);
  assert.equal(a.compat, undefined, "the default result is not labelled");
  /* the two seeds converge, so the difference is in the early bars */
  assert.notEqual(a.values[20], b.values[20]);
});

test("compat: \"default\" and no compat are the same", async () => {
  const a = await tools.compute({ indicator: "rsi", bars, tail: 3 });
  const b = await tools.compute({ indicator: "rsi", bars, tail: 3, compat: "default" });
  assert.deepEqual(a.values, b.values);
});

test("compat on an indicator without one is an error naming the nine", async () => {
  await assert.rejects(
    () => tools.compute({ indicator: "ema", bars, compat: "talib" }),
    (e) => /ema has no TA-Lib compatibility mode/.test(e.message) && NINE.every((n) => e.message.includes(n))
  );
});

test("an unknown compat mode is refused", async () => {
  await assert.rejects(() => tools.compute({ indicator: "rsi", bars, compat: "tulip" }), /unknown compat mode "tulip"/);
});

test("compat still checks parameters: an unknown name and a required one", async () => {
  await assert.rejects(() => tools.compute({ indicator: "rsi", bars, compat: "talib", params: { period: 14 } }), /no parameter `period`/);
  await assert.rejects(() => tools.compute({ indicator: "sma", bars, compat: "talib" }), /`n` has no default/);
});

test("a later parameter alone keeps the earlier defaults in compat mode too", async () => {
  const r = await tools.compute({ indicator: "bollinger", bars, compat: "talib", params: { mult: 3 }, tail: 1 });
  const d = await tools.compute({ indicator: "bollinger", bars, compat: "talib", tail: 1 });
  assert.equal(r.values.mid[0], d.values.mid[0]);
  assert.ok(r.values.upper[0] > d.values.upper[0]);
});

test("compute_many: top-level compat applies where it exists and reports where it does not", async () => {
  const r = await tools.compute_many({ indicators: ["rsi", "ema", { indicator: "atr", params: { n: 10 } }], bars, compat: "talib", tail: 2 });
  assert.deepEqual(r.results.map((x) => x.indicator), ["rsi", "atr"]);
  assert.ok(r.results.every((x) => x.compat === "talib"));
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].indicator, "ema");
  assert.match(r.errors[0].error, /no TA-Lib compatibility mode/);
});

test("compute_many: an item's own compat overrides the call's", async () => {
  const r = await tools.compute_many({ indicators: ["rsi", { indicator: "rsi", compat: "talib" }], bars: bars.slice(0, 40), tail: 1 });
  assert.equal(r.results[0].compat, undefined);
  assert.equal(r.results[1].compat, "talib");
  assert.notEqual(r.results[0].values[0], r.results[1].values[0]);
});

test("describe_indicator says whether an indicator has the mode, and what it changes", () => {
  const rsi = tools.describe_indicator({ indicator: "rsi" });
  assert.deepEqual(rsi.compat.supported, ["talib"]);
  assert.match(rsi.compat.effect, /TA-Lib 0\.7\.1/);
  assert.match(rsi.compat.effect, /bar n/);
  assert.match(tools.describe_indicator({ indicator: "stochRsi" }).compat.effect, /fastk_period/);
  assert.match(tools.describe_indicator({ indicator: "ema" }).compat, /none/);
  for (const n of NINE) assert.ok(tools.describe_indicator({ indicator: n }).compat.effect.length > 40, n);
});

test("list_indicators marks the nine and only the nine", () => {
  const rows = tools.list_indicators().indicators;
  assert.deepEqual(rows.filter((r) => r.compat).map((r) => r.name).sort(), NINE);
  assert.equal(rows.length, 89);
  assert.deepEqual(rows.find((r) => r.name === "macd").compat, ["talib"]);
});

test("the library's scanners and candle functions are not offered as indicators", () => {
  const names = tools.list_indicators().indicators.map((r) => r.name);
  for (const n of ["engulfing", "doji", "hikkakeMod", "indicatorEvents", "detectPatterns", "zigzag", "candlesAt", "volumeRatio"]) {
    assert.ok(!names.includes(n), n);
  }
});

test("supertrend's boolean line survives the shaping (it was rounded to null before 0.2.0)", async () => {
  const r = await tools.compute({ indicator: "supertrend", bars, tail: 5 });
  assert.ok(r.values.up.every((v) => typeof v === "boolean"), JSON.stringify(r.values.up));
});
