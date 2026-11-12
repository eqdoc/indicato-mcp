/* list_candles, find_candles, find_events, find_patterns.
 *
 * Reference values come from indicato 0.3.0's own fixtures (test/fixtures/reference.json is
 * a slice of them): 600 sessions of RELIANCE with TA-Lib 0.7.1's output for all 61 candle
 * patterns and the events and chart patterns eqdoc's Python scan finds on the same bars.
 * These tests check that the tools hand those results over unchanged and summarise them
 * correctly; that indicato computes them correctly is indicato's own test suite's job. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tools } from "../src/tools.js";
import { CANDLE_PATTERNS, CURATED_CANDLES, EVENT_SIGNALS } from "indicato";

const REF = JSON.parse(readFileSync(new URL("./fixtures/reference.json", import.meta.url), "utf8"));
const dated = (rows) => rows.map(([date, o, h, l, c, v]) => ({ date, o, h, l, c, v }));
const bars = dated(REF.reliance);
const dir = await mkdtemp(join(tmpdir(), "indicato-mcp-scan-"));

async function csv(name, rows, header = "Date,Open,High,Low,Close,Volume") {
  const file = join(dir, name);
  await writeFile(file, [header, ...rows.map((r) => r.join(","))].join("\n"));
  return file;
}

/* ---- list_candles ------------------------------------------------------------------------ */

test("list_candles lists all 61 and flags the curated 20", () => {
  const r = tools.list_candles();
  assert.equal(r.count, 61);
  assert.equal(r.curatedCount, 20);
  assert.equal(r.patterns.filter((p) => p.curated).length, 20);
  assert.deepEqual(r.patterns.filter((p) => p.curated).map((p) => p.name), CURATED_CANDLES);
  assert.ok(r.patterns.every((p) => Number.isInteger(p.lookback) && p.lookback >= 2));
  assert.deepEqual(r.patterns.map((p) => p.name), Object.keys(CANDLE_PATTERNS));
});

test("list_candles filters by name and by curated flag", () => {
  assert.deepEqual(tools.list_candles({ search: "doji" }).patterns.map((p) => p.name).sort(),
    Object.keys(CANDLE_PATTERNS).filter((n) => n.toLowerCase().includes("doji")).sort());
  assert.equal(tools.list_candles({ curated: false }).count, 41);
  assert.equal(tools.list_candles({ curated: true }).count, 20);
});

/* ---- find_candles ------------------------------------------------------------------------ */

const refHits = (names) =>
  names.flatMap((n) => REF.candles[n].map(([i, value]) => ({ i, pattern: n, value })));

test("find_candles (curated, the default) finds exactly TA-Lib's hits for the 20", async () => {
  const r = await tools.find_candles({ bars, full: true });
  const want = refHits(CURATED_CANDLES);
  assert.equal(r.totalHits, want.length);
  assert.ok(want.length > 20, "a fixture with something to find");
  const key = (h) => `${h.i}|${h.pattern}|${h.value}`;
  assert.deepEqual(r.hits.map(key).sort(), want.map(key).sort());
  assert.match(r.scanned, /20 curated/);
  assert.ok(!r.note.includes("fire on 6-23%"), "no indecision-shape warning when only the curated set ran");
});

test("find_candles counts by pattern and side agree with the hits", async () => {
  const r = await tools.find_candles({ bars, full: true });
  for (const [name, row] of Object.entries(r.byPattern)) {
    const mine = r.hits.filter((h) => h.pattern === name);
    assert.equal(row.bull, mine.filter((h) => h.side === "bull").length, name);
    assert.equal(row.bear, mine.filter((h) => h.side === "bear").length, name);
  }
  assert.equal(Object.values(r.byPattern).reduce((s, x) => s + x.bull + x.bear, 0), r.totalHits);
});

test("find_candles side follows the sign of TA-Lib's value", async () => {
  const r = await tools.find_candles({ bars, set: "all", full: true });
  for (const h of r.hits) assert.equal(h.side, h.value > 0 ? "bull" : "bear");
  assert.ok(r.hits.some((h) => Math.abs(h.value) === 80) || r.hits.some((h) => Math.abs(h.value) === 100));
});

test("find_candles set: all finds all 61 patterns' hits and flags curated ones", async () => {
  const r = await tools.find_candles({ bars, set: "all", full: true });
  assert.equal(r.totalHits, refHits(Object.keys(CANDLE_PATTERNS)).length);
  assert.equal(r.scanned, "all 61");
  assert.match(r.note, /6-23%/);
  assert.equal(r.byPattern.engulfing.curated, true);
  assert.equal(r.byPattern.doji.curated, false);
});

test("find_candles returns the last N hits, oldest first, with bar index and date", async () => {
  const all = await tools.find_candles({ bars, full: true });
  const r = await tools.find_candles({ bars, tail: 4 });
  assert.equal(r.hits.length, 4);
  assert.deepEqual(r.hits.map((h) => h.i), all.hits.slice(-4).map((h) => h.i));
  assert.ok(r.hits.every((h, k) => k === 0 || h.i >= r.hits[k - 1].i));
  for (const h of r.hits) assert.equal(h.date, REF.reliance[h.i][0]);
  assert.equal(r.showing, `last 4 of ${all.totalHits} hits`);
  assert.equal(r.lastBar.i, 599);
  assert.equal(r.lastBar.date, REF.reliance[599][0]);
  assert.equal(r.totalHits, all.totalHits, "counts cover everything, not just the tail");
});

test("find_candles defaults to ten hits", async () => {
  const r = await tools.find_candles({ bars });
  assert.equal(r.hits.length, 10);
});

test("find_candles takes named patterns, and names the unknown ones", async () => {
  const r = await tools.find_candles({ bars, patterns: ["engulfing", "doji"], full: true });
  assert.equal(r.totalHits, refHits(["engulfing", "doji"]).length);
  assert.deepEqual(r.scanned, ["engulfing", "doji"]);
  assert.ok(r.hits.every((h) => ["engulfing", "doji"].includes(h.pattern)));
  await assert.rejects(() => tools.find_candles({ bars, patterns: ["engulfin"] }), /unknown candle pattern: `engulfin`.*engulfing/);
  await assert.rejects(() => tools.find_candles({ bars, patterns: [] }), /non-empty array/);
  await assert.rejects(() => tools.find_candles({ bars, set: "some" }), /"curated".*"all"/);
});

test("find_candles has no date when the data has none", async () => {
  const r = await tools.find_candles({ bars: bars.map(({ date, ...b }) => b), tail: 3 });
  assert.ok(r.hits.every((h) => h.date === undefined));
  assert.equal(r.lastBar.date, undefined);
});

test("find_candles refuses a list of closes, and a file with no open, high or low", async () => {
  await assert.rejects(() => tools.find_candles({ bars: bars.map((b) => b.c) }), /plain list of closes/);
  const file = await csv("closes.csv", REF.reliance.slice(0, 50).map((r) => [r[0], r[4]]), "Date,Close");
  await assert.rejects(() => tools.find_candles({ file }), /no open, high, low/);
  await assert.rejects(() => tools.find_candles({ bars: bars.slice(0, 30).map(({ o, h, ...b }) => b) }), /no open, high/);
  await assert.rejects(() => tools.find_candles({}), /either `bars`/);
});

test("find_candles needs no volume", async () => {
  const noVol = bars.map(({ v, ...b }) => b);
  const r = await tools.find_candles({ bars: noVol, full: true });
  assert.equal(r.totalHits, refHits(CURATED_CANDLES).length);
});

test("find_candles reads a CSV, reports the columns, and returns dates", async () => {
  const file = await csv("reliance.csv", REF.reliance);
  const r = await tools.find_candles({ file, full: true });
  assert.equal(r.totalHits, refHits(CURATED_CANDLES).length);
  assert.equal(r.source.rows, 600);
  assert.equal(r.source.columns.o, "Open");
  assert.equal(r.hits[0].date, REF.reliance[r.hits[0].i][0]);
});

test("find_candles puts a newest-first CSV right and says so", async () => {
  const file = await csv("reversed.csv", [...REF.reliance].reverse());
  const r = await tools.find_candles({ file, full: true });
  assert.equal(r.source.reversedToOldestFirst, true);
  assert.equal(r.totalHits, refHits(CURATED_CANDLES).length);
  assert.equal(r.lastBar.date, REF.reliance[599][0]);
});

/* ---- find_events ------------------------------------------------------------------------- */

test("find_events returns exactly the reference events, bar and side, for all eleven signals", async () => {
  const r = await tools.find_events({ bars, full: true });
  const keys = Object.keys(EVENT_SIGNALS);
  assert.equal(keys.length, 11);
  assert.deepEqual(Object.keys(r.signals), keys);
  let total = 0;
  for (const k of keys) {
    const want = REF.events[k].map(([i, side]) => `${i}|${side}`);
    const got = r.events.filter((e) => e.signal === k).map((e) => `${e.i}|${e.side}`);
    assert.deepEqual(got, want, k);
    assert.equal(r.signals[k].bull + r.signals[k].bear, want.length, `${k} counts`);
    total += want.length;
  }
  assert.equal(r.totalEvents, total);
  assert.ok(total > 100);
});

test("find_events labels each event in plain words and dates it", async () => {
  const r = await tools.find_events({ bars, full: true });
  for (const e of r.events) {
    assert.equal(e.event, EVENT_SIGNALS[e.signal].names[e.side]);
    assert.equal(e.date, REF.reliance[e.i][0]);
  }
});

test("find_events carries the two pivots on a divergence and nothing on a crossing", async () => {
  const r = await tools.find_events({ bars, full: true });
  const div = r.events.filter((e) => e.signal === "rsidiv");
  assert.equal(div.length, REF.events.rsidiv.length);
  div.forEach((e, n) => {
    const g = REF.events.rsidiv[n][2];
    assert.equal(e.geometry.p1.bar, g.p1[0]);
    assert.equal(e.geometry.p2.bar, g.p2[0]);
    assert.ok(Math.abs(e.geometry.p2.price - g.p2[1]) < 1e-5);
    assert.equal(e.geometry.p1.date, REF.reliance[g.p1[0]][0]);
    assert.ok(e.geometry.p2.bar < e.i, "dated the bar the pivot is confirmed, after the pivot");
  });
  assert.ok(r.events.filter((e) => e.signal === "stoch").every((e) => e.geometry === undefined));
});

test("find_events returns the last N across signals, oldest first", async () => {
  const all = await tools.find_events({ bars, full: true });
  const r = await tools.find_events({ bars, tail: 5 });
  assert.equal(r.events.length, 5);
  assert.deepEqual(r.events.map((e) => e.i), all.events.slice(-5).map((e) => e.i));
  assert.equal(r.showing, `last 5 of ${all.totalEvents} events`);
  assert.equal(r.totalEvents, all.totalEvents);
  assert.equal((await tools.find_events({ bars })).events.length, 10);
});

test("find_events can be limited to some signals, and names the unknown ones", async () => {
  const r = await tools.find_events({ bars, signals: ["nr7", "gap"], full: true });
  assert.deepEqual(Object.keys(r.signals), ["nr7", "gap"]);
  assert.equal(r.totalEvents, REF.events.nr7.length + REF.events.gap.length);
  assert.ok(r.events.every((e) => ["nr7", "gap"].includes(e.signal)));
  await assert.rejects(() => tools.find_events({ bars, signals: ["rsi"] }), /unknown event signal: `rsi`.*stoch/);
});

test("find_events reports a signal that did not fire as zero, not as absent", async () => {
  const r = await tools.find_events({ bars, signals: ["vol52"] });
  assert.equal(REF.events.vol52.length, 0);
  assert.deepEqual(r.signals.vol52.bull + r.signals.vol52.bear, 0);
  assert.equal(r.events.length, 0);
});

test("find_events refuses closes, and bars with no volume", async () => {
  await assert.rejects(() => tools.find_events({ bars: bars.map((b) => b.c) }), /plain list of closes/);
  await assert.rejects(() => tools.find_events({ bars: bars.map(({ v, ...b }) => b) }), /no volume/);
});

test("find_events warns when there are too few bars for any event", async () => {
  const r = await tools.find_events({ bars: bars.slice(0, 40) });
  assert.equal(r.totalEvents, 0);
  assert.match(r.warning, /only 40 bars/);
});

/* ---- find_patterns ----------------------------------------------------------------------- */

const near = (a, b, path = "") => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 0.011 ? null : `${path}: ${a} vs ${b}`;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b ? null : `${path}: ${a} vs ${b}`;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) return `${path}: keys ${ka} vs ${kb}`;
  for (const k of ka) { const r = near(a[k], b[k], `${path}.${k}`); if (r) return r; }
  return null;
};

for (const [label, c] of Object.entries(REF.patterns)) {
  test(`find_patterns equals the reference detections, geometry included (${label})`, async () => {
    const r = await tools.find_patterns({ bars: dated(c.bars), full: true });
    assert.equal(r.totalPatterns, c.detections.length);
    assert.equal(r.patterns.length, c.detections.length);
    for (const ref of c.detections) {
      const got = r.patterns.find((p) => p.name === ref.name && p.side === ref.side);
      assert.ok(got, `${ref.name} (${ref.side}) found`);
      assert.equal(got.state, ref.state);
      assert.equal(got.timeframe, ref.tf);
      assert.equal(got.formed, ref.formed_date);
      assert.equal(got.confidence, ref.conf);
      assert.equal(near(got.geometry, ref.geometry), null, `${ref.name} geometry`);
      assert.ok(got.geometry.points.length >= 2 && got.geometry.points.every((p) => p.d && typeof p.p === "number"));
      assert.ok(got.geometry.lines.length >= 1 && got.geometry.lines.every((l) => l.from.d && l.to.d));
      if (ref.tf === "daily") assert.equal(got.formedBar, ref.formed_i);
      else assert.equal(got.formedBar, undefined, "a weekly index is not a daily bar");
    }
    assert.equal(r.asOf, c.bars[c.bars.length - 1][0]);
  });
}

test("find_patterns counts states over everything and filters by state", async () => {
  const c = REF.patterns["TCS@539"];
  const all = await tools.find_patterns({ bars: dated(c.bars), full: true });
  assert.deepEqual(all.byState, { forming: 3, confirmed: 0, failed: 0 });
  const none = await tools.find_patterns({ bars: dated(c.bars), state: ["confirmed"] });
  assert.equal(none.patterns.length, 0);
  assert.equal(none.byState.forming, 3, "the counts do not follow the filter");
  const some = await tools.find_patterns({ bars: dated(c.bars), state: "forming" });
  assert.equal(some.patterns.length, 3);
  await assert.rejects(() => tools.find_patterns({ bars: dated(c.bars), state: ["done"] }), /unknown state: `done`.*forming/);
});

test("find_patterns can leave the weekly bars out and leave the geometry out", async () => {
  const c = REF.patterns["TCS@539"];
  const daily = await tools.find_patterns({ bars: dated(c.bars), weekly: false, geometry: false, full: true });
  assert.equal(daily.weekly, false);
  assert.ok(daily.patterns.every((p) => p.timeframe === "daily" && p.geometry === undefined));
  assert.equal(daily.totalPatterns, 2);
});

test("find_patterns returns the newest N, oldest first", async () => {
  const c = REF.patterns["TCS@539"];
  const r = await tools.find_patterns({ bars: dated(c.bars), tail: 2 });
  assert.equal(r.patterns.length, 2);
  assert.equal(r.showing, "last 2 of 3 patterns");
  assert.ok(r.patterns[0].formed <= r.patterns[1].formed);
});

test("find_patterns reads a CSV, newest-first, and takes its dates from it", async () => {
  const c = REF.patterns["RELIANCE@599"];
  const file = await csv("p.csv", [...c.bars].reverse());
  const r = await tools.find_patterns({ file });
  assert.equal(r.source.reversedToOldestFirst, true);
  assert.equal(r.patterns.length, c.detections.length);
  assert.equal(r.patterns[0].name, c.detections[0].name);
});

test("find_patterns accepts dates that are not ISO and reads them as calendar days", async () => {
  const c = REF.patterns["RELIANCE@599"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const odd = dated(c.bars).map((b) => {
    const [y, m, d] = b.date.split("-");
    return { ...b, date: `${d}-${months[+m - 1]}-${y}` };
  });
  const r = await tools.find_patterns({ bars: odd });
  assert.equal(r.patterns[0].formed, c.detections[0].formed_date);
  assert.equal(r.asOf, c.bars[c.bars.length - 1][0]);
});

test("find_patterns refuses bars without dates, closes, or volume", async () => {
  const c = REF.patterns["RELIANCE@599"];
  await assert.rejects(() => tools.find_patterns({ bars: dated(c.bars).map(({ date, ...b }) => b) }), /needs a date on every bar.*bar 0 has none/);
  await assert.rejects(() => tools.find_patterns({ bars: dated(c.bars).map((b) => ({ ...b, date: "someday" })) }), /unreadable/);
  await assert.rejects(() => tools.find_patterns({ bars: c.bars.map((b) => b[4]) }), /plain list of closes/);
  await assert.rejects(() => tools.find_patterns({ bars: dated(c.bars).map(({ v, ...b }) => b) }), /no volume/);
});

test("find_patterns says when there are too few bars for a daily pattern", async () => {
  const r = await tools.find_patterns({ bars: dated(REF.patterns["RELIANCE@599"].bars).slice(0, 60) });
  assert.equal(r.patterns.length, 0);
  assert.match(r.note, /at least 80 bars; 60 given/);
});

/* ---- output size ------------------------------------------------------------------------- */

test("the default outputs stay small on a long history", async () => {
  const long = [];
  for (let k = 0; k < 8; k++) {
    for (const b of bars) long.push({ ...b, date: `${2010 + k * 3}-${b.date.slice(5)}` });
  }
  assert.equal(long.length, 4800);
  for (const [tool, extra] of [["find_candles", { set: "all" }], ["find_events", {}], ["find_patterns", {}]]) {
    const out = JSON.stringify(await tools[tool]({ bars: long, ...extra }));
    assert.ok(out.length < 12000, `${tool}: ${out.length} bytes`);
  }
});
