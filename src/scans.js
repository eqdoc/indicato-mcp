/*
 * The three scanners — candlestick patterns, indicator events, chart patterns — and the
 * 61-pattern catalogue.
 *
 * They follow the rule `compute` follows: counts first, then the most recent few, and
 * the whole list only when asked for. A 20-year daily history through the 61 candle
 * patterns is several thousand hits, none of which a model needs in order to say what
 * the last month looked like.
 *
 * They also refuse input the indicators accept. `compute` is happy to run `sma` over a
 * list of closes, and a missing open or high is filled from the close, which is harmless
 * for a moving average. For a candle scan it is not: a candle with open, high, low and
 * close all equal is a doji, so a close series would "find" a doji on every bar. A scan
 * that cannot be right is refused, with the reason.
 */
import {
  CANDLE_PATTERNS, CURATED_CANDLES, candleLookback,
  indicatorEvents, EVENT_SIGNALS, WARMUP, detectPatterns,
} from "indicato";
import { resolveBars, isoDay } from "./bars.js";

const round = (v) => (typeof v === "number" && Number.isFinite(v) ? +v.toFixed(6) : v);
const CANDLE_NAMES = Object.keys(CANDLE_PATTERNS);
const CURATED = new Set(CURATED_CANDLES);
const EVENT_KEYS = Object.keys(EVENT_SIGNALS);
const STATES = ["forming", "confirmed", "failed"];
const COLUMN_WORD = { o: "open", h: "high", l: "low", v: "volume" };

async function barsFor(args, tool, { volume }) {
  const r = await resolveBars(args);
  const need = volume ? ["o", "h", "l", "v"] : ["o", "h", "l"];
  const missing = need.filter((k) => r.lacks.includes(k));
  if (missing.length) {
    const words = need.map((k) => COLUMN_WORD[k]);
    throw new Error(
      `${tool} reads the ${words.slice(0, -1).join(", ")} and ${words[words.length - 1]} of every bar, ` +
      (r.source.fromClosesOnly
        ? "and was given a plain list of closes. "
        : `and this input has no ${missing.map((k) => COLUMN_WORD[k]).join(", ")}. `) +
      (volume
        ? "Without them the answer would be wrong rather than empty, so it is refused."
        : "A candle cannot be read from a close alone, so it is refused.")
    );
  }
  return r;
}

const dateOf = (bar) => (bar.t === undefined ? undefined : String(bar.t));

/* Newest `tail` of an oldest-first list, or all of it. */
const newest = (list, tail, full) => (full ? list : list.slice(-tail));

function nearest(name, pool) {
  const q = String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!q) return [];
  return pool.filter((n) => n.toLowerCase().includes(q) || q.includes(n.toLowerCase())).slice(0, 5);
}

function pick(list, label, pool) {
  const unknown = list.filter((n) => !pool.includes(n));
  if (unknown.length) {
    const hints = unknown.map((u) => {
      const near = nearest(u, pool);
      return `\`${u}\`` + (near.length ? ` (did you mean ${near.join(", ")}?)` : "");
    });
    throw new Error(`unknown ${label}: ${hints.join("; ")}. The ${pool.length} are: ${pool.join(", ")}.`);
  }
  return list;
}

export const scans = {
  list_candles({ search, curated } = {}) {
    const q = search ? String(search).toLowerCase() : null;
    const rows = CANDLE_NAMES
      .filter((n) => (!q || n.toLowerCase().includes(q)) && (curated === undefined || CURATED.has(n) === curated))
      .map((n) => ({ name: n, curated: CURATED.has(n), lookback: candleLookback(n) }));
    return {
      count: rows.length,
      curatedCount: CURATED.size,
      note:
        "All 61 of TA-Lib's candlestick patterns. The 20 flagged `curated` are the reversal and continuation " +
        "shapes; find_candles scans those by default. The other 41 mostly describe a candle's shape (doji, " +
        "spinning top, long line) and fire on a large share of all bars. `lookback` is how many leading bars " +
        "a pattern leaves at zero.",
      patterns: rows,
    };
  },

  async find_candles(args) {
    const { bars, source } = await barsFor(args, "find_candles", { volume: false });
    let names;
    let set;
    if (args.patterns !== undefined) {
      if (!Array.isArray(args.patterns) || !args.patterns.length) {
        throw new Error("`patterns` must be a non-empty array of pattern names. Call list_candles for them.");
      }
      names = pick(args.patterns, "candle pattern", CANDLE_NAMES);
      set = "named";
    } else {
      set = args.set ?? "curated";
      if (set !== "curated" && set !== "all") {
        throw new Error(`\`set\` is "curated" (the 20 reversal and continuation shapes, the default) or "all" (all 61), not ${JSON.stringify(set)}.`);
      }
      names = set === "all" ? CANDLE_NAMES : CURATED_CANDLES;
    }

    const tail = args.tail ?? 10;
    const hits = [];
    const byPattern = {};
    for (const name of names) {
      const series = CANDLE_PATTERNS[name](bars);
      for (let i = 0; i < series.length; i++) {
        const value = series[i];
        if (!value) continue;
        const side = value > 0 ? "bull" : "bear";
        hits.push({ i, date: dateOf(bars[i]), pattern: name, side, value });
        const row = (byPattern[name] ??= { bull: 0, bear: 0, ...(set !== "curated" ? { curated: CURATED.has(name) } : {}) });
        row[side]++;
      }
    }
    /* Oldest first; patterns that fire on the same bar keep the order they were asked in. */
    hits.sort((a, b) => a.i - b.i);
    const last = bars.length - 1;
    const withNote = set !== "curated" && names.some((n) => !CURATED.has(n));
    return {
      source,
      bars: bars.length,
      lastBar: { i: last, date: dateOf(bars[last]) },
      scanned: set === "named" ? names : set === "all" ? "all 61" : "the 20 curated",
      totalHits: hits.length,
      byPattern,
      hits: newest(hits, tail, args.full === true),
      showing: args.full ? `all ${hits.length} hits` : `last ${Math.min(tail, hits.length)} of ${hits.length} hits`,
      note:
        "value is TA-Lib's signed integer: +100 bullish, -100 bearish, +-80 the weaker equal-edge Engulfing and " +
        "Harami, +-200 a confirmed Hikkake. A pattern describes the shape of recent candles, not what price does next." +
        (withNote
          ? " Some of the non-curated patterns describe shape, not an event, and fire on 6-23% of all bars (spinningTop, longLine, beltHold, shortLine, doji)."
          : ""),
    };
  },

  async find_events(args) {
    const { bars, source } = await barsFor(args, "find_events", { volume: true });
    const keys = args.signals === undefined
      ? EVENT_KEYS
      : pick(Array.isArray(args.signals) ? args.signals : [args.signals], "event signal", EVENT_KEYS);

    const tail = args.tail ?? 10;
    const found = indicatorEvents(bars);
    const summary = {};
    const events = [];
    const pivot = (p) => ({ bar: p[0], date: dateOf(bars[p[0]]), price: round(p[1]), indicator: round(p[2]) });
    for (const key of keys) {
      summary[key] = { bull: 0, bear: 0 };
      for (const e of found[key]) {
        summary[key][e.side]++;
        events.push({
          i: e.i,
          date: dateOf(bars[e.i]),
          signal: key,
          side: e.side,
          event: EVENT_SIGNALS[key].names[e.side],
          ...(e.geometry ? { geometry: { p1: pivot(e.geometry.p1), p2: pivot(e.geometry.p2) } } : {}),
        });
      }
    }
    events.sort((a, b) => a.i - b.i);
    const last = bars.length - 1;
    return {
      source,
      bars: bars.length,
      lastBar: { i: last, date: dateOf(bars[last]) },
      totalEvents: events.length,
      signals: summary,
      events: newest(events, tail, args.full === true),
      showing: args.full ? `all ${events.length} events` : `last ${Math.min(tail, events.length)} of ${events.length} events`,
      note:
        `An event is something that happened on one bar. None fires in the first ${WARMUP} bars. Divergences are ` +
        "dated the bar their second pivot is confirmed, not the pivot itself; geometry names the two pivots " +
        "(bar, price, indicator value). Events describe past price behaviour and predict nothing.",
      ...(bars.length <= WARMUP ? { warning: `only ${bars.length} bars; no event can fire before bar ${WARMUP}.` } : {}),
    };
  },

  async find_patterns(args) {
    const { bars, source } = await barsFor(args, "find_patterns", { volume: true });
    const rows = bars.map((b, i) => {
      const d = b.t === undefined ? null : isoDay(b.t);
      if (!d) {
        throw new Error(
          `find_patterns needs a date on every bar to build weekly bars and place each point; bar ${i} ` +
          (b.t === undefined ? "has none." : `has an unreadable one (${JSON.stringify(String(b.t)).slice(0, 40)}).`) +
          " Use a CSV with a date column, or bars with a `date` field (YYYY-MM-DD)."
        );
      }
      return { d, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    });

    let state;
    if (args.state !== undefined) {
      state = pick(Array.isArray(args.state) ? args.state : [args.state], "state", STATES);
    }
    const tail = args.tail ?? 10;
    const withGeometry = args.geometry !== false;
    const all = detectPatterns(rows, { weekly: args.weekly !== false });

    const count = { forming: 0, confirmed: 0, failed: 0 };
    for (const p of all) count[p.state]++;
    const shown = all
      .filter((p) => !state || state.includes(p.state))
      .sort((a, b) => (a.formedDate < b.formedDate ? -1 : a.formedDate > b.formedDate ? 1 : 0))
      .map((p) => ({
        name: p.name,
        side: p.side,
        state: p.state,
        timeframe: p.tf,
        formed: p.formedDate,
        ...(p.tf === "daily" ? { formedBar: p.formedIndex } : {}),
        confidence: p.conf,
        ...(withGeometry ? { geometry: p.geometry } : {}),
      }));
    const out = newest(shown, tail, args.full === true);
    return {
      source,
      bars: bars.length,
      asOf: rows[rows.length - 1].d,
      weekly: args.weekly !== false,
      totalPatterns: all.length,
      byState: count,
      patterns: out,
      showing: args.full ? `all ${shown.length} patterns` : `last ${Math.min(tail, shown.length)} of ${shown.length} patterns`,
      note:
        "One detection per pattern and side, the most recent, and only recent ones: a confirmed or failed pattern is " +
        "reported for 20 sessions after its break (6 weeks on weekly bars). `forming` is a complete structure whose " +
        "line has not broken; `confirmed` is a close through the line on volume of at least 1.25x the 20-session mean; " +
        "`failed` means the structure was invalidated. geometry.points and geometry.lines carry dates and prices for " +
        "drawing. confidence is 1-3. Detection is anchored on the last bar and scaled to the volatility of the history " +
        "given, so pass the history you mean; indicato's own reference tests use the last 520 daily bars (about two years). " +
        "These describe past price behaviour; none predicts anything." +
        (rows.length < 80 ? ` Daily patterns need at least 80 bars; ${rows.length} given.` : ""),
    };
  },
};
