/*
 * The catalogue is read off the functions themselves.
 *
 * A hand-written table of 89 indicators and their parameters would be wrong within a
 * release — someone adds a function, or changes a default, and the table silently
 * disagrees with the code. Parsing the signature costs a millisecond at startup and
 * cannot drift.
 *
 * Two things are needed per function and neither is declared anywhere:
 *
 *   what it takes   — the first parameter is either `bars` (needs OHLCV) or a plain
 *                     series such as `src`/`values` (needs one column). The name is
 *                     the only signal, and it is a reliable one because the library
 *                     is consistent about it.
 *
 *   what it returns — an array, or an object of arrays. Determined by calling the
 *                     function once on synthetic bars. A probe is honest where a
 *                     regex over the body would not be.
 */
import * as TA from "indicato";
import { CANDLE_PATTERNS } from "indicato";

const SIG = /^(?:async\s*)?(?:function\s*[\w$]*\s*)?\(([^)]*)\)|^([\w$]+)\s*=>/;

/* Split on commas that are not inside brackets, so `n = [1,2]` stays one parameter. */
function splitParams(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  if (start < s.length) out.push(s.slice(start));
  return out.map((p) => p.trim()).filter(Boolean);
}

function parseSignature(fn) {
  const src = fn.toString();
  const m = src.match(SIG);
  if (!m) return [];
  const inner = m[1] !== undefined ? m[1] : m[2];
  return splitParams(inner).map((p) => {
    const eq = p.indexOf("=");
    if (eq === -1) return { name: p, required: true };
    const name = p.slice(0, eq).trim();
    const raw = p.slice(eq + 1).trim();
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    return { name, required: false, default: value };
  });
}

/* Enough bars for the longest default warmup in the library, trending so that
 * direction-sensitive functions produce something other than a flat line. */
function probeBars(n = 400) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i * 0.35 + Math.sin(i / 7) * 4;
    bars.push({
      o: +(base).toFixed(4),
      h: +(base + 1.2).toFixed(4),
      l: +(base - 1.1).toFixed(4),
      c: +(base + 0.4).toFixed(4),
      v: 100000 + ((i * 7919) % 50000),
    });
  }
  return bars;
}

function probeOutput(fn, input) {
  const bars = probeBars();
  try {
    const closes = bars.map((b) => b.c);
    const out =
      input === "bars" ? fn(bars)
      : input === "pair" ? fn(closes, closes.map((c, i) => c * 0.9 + i * 0.01))
      : fn(closes);
    if (Array.isArray(out)) return { kind: "series", lines: null };
    if (out && typeof out === "object") return { kind: "object", lines: Object.keys(out) };
    return { kind: "scalar", lines: null };
  } catch {
    return { kind: "unknown", lines: null };
  }
}

const SERIES_FIRST = new Set(["src", "values", "value", "series", "a", "b", "v", "x", "y"]);

/* A handful of indicators relate two series — a stock against an index. They are the
 * only functions here that cannot be answered from one set of bars, so they are given
 * their own input kind and the caller is asked for a benchmark. */
const PAIR_SECOND = new Set(["b", "y", "benchmark", "market", "index", "other"]);

/* From 0.2 indicato also exports the 61 candlestick functions, three scanners and a few
 * helpers, and every one of them is a function. They are not indicators: they return
 * integers per bar, events or patterns, and each has its own tool here. Everything else
 * that is a function is an indicator, so the sixty-one are taken from the library's own
 * table and the ten others are named. If a release adds an eleventh, the count in the
 * tests stops matching and says so. */
const NOT_INDICATORS = new Set([
  ...Object.keys(CANDLE_PATTERNS),
  "candleLookback", "candlesAt", "indicatorEvents", "eventConfirmations", "fractalPivots",
  "volumeRatio", "chartBars", "detectPatterns", "weeklyBars", "zigzag",
]);

/* indicato 0.3 puts `opts` last on the nine functions that have a TA-Lib mode. It is not
 * a parameter anyone sets by name, so it is lifted out of the list and recorded as
 * `compat`. */
export const COMPAT_NOTES = {
  sma: "Divides the running total first, then drops the oldest value (TA-Lib's order).",
  rsi: "First n changes averaged, first value at bar n (default: bar n-1, seeded one bar earlier).",
  atr: "Averages true ranges from bar 1 to n, first value at bar n (default: bar 0's range is included).",
  dmi: "TA-Lib's PLUS_DI, MINUS_DI and ADX: DI from bar n, ADX from bar 2n-1.",
  macd: "Both EMAs seeded at bar slow-1; line, signal and hist all start at slow+signal-2 (bar 33 by default).",
  bollinger: "TA-Lib's BBANDS: running-total mean, deviation from the mean of squares less the square of the mean.",
  stochRsi: "Raw fastk over the last k RSI values and its d-bar mean. `k` is then TA-Lib's fastk_period, whose own default is 5 (this server's default for k stays 3, so pass k: 5 to match talib.STOCHRSI defaults).",
  psar: "The first leg is decided by the first bar's minus-DM.",
  supertrend: "No TA-Lib function exists; this is the Supertrend a Python scan writes on talib.ATR: ATR from bar n, first leg a downtrend.",
};

function build() {
  const out = new Map();
  for (const [name, fn] of Object.entries(TA)) {
    if (typeof fn !== "function" || NOT_INDICATORS.has(name)) continue;
    const all = parseSignature(fn);
    const compat = all.length > 0 && all[all.length - 1].name === "opts";
    const params = compat ? all.slice(0, -1) : all;
    const [first, second] = params;
    let input = "bars", consumed = 1;
    if (first && SERIES_FIRST.has(first.name)) {
      input = "series";
      if (second && PAIR_SECOND.has(second.name)) { input = "pair"; consumed = 2; }
    }
    const shape = probeOutput(fn, input);
    out.set(name, {
      name,
      input,
      inputName: first ? first.name : "bars",
      params: params.slice(consumed),
      compat,
      output: shape.kind,
      lines: shape.lines,
    });
  }
  return out;
}

export const MANIFEST = build();
export const NAMES = [...MANIFEST.keys()].sort();

export function get(name) {
  const e = MANIFEST.get(name);
  if (e) return e;
  const lower = String(name).toLowerCase();
  for (const [k, v] of MANIFEST) if (k.toLowerCase() === lower) return v;
  return null;
}

/* Suggest by prefix and substring — a model that asks for "bollingerbands" or "BB"
 * should be told the name rather than left to guess a second time. */
export function suggest(name, limit = 6) {
  const q = String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!q) return [];
  const score = (n) => {
    const k = n.toLowerCase();
    if (k.startsWith(q)) return 0;
    if (k.includes(q)) return 1;
    if (q.includes(k)) return 2;
    return 3;
  };
  return NAMES.map((n) => [n, score(n)]).filter(([, s]) => s < 3)
    .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length)
    .slice(0, limit).map(([n]) => n);
}

export const COMPAT_NAMES = NAMES.filter((n) => MANIFEST.get(n).compat);

export { TA };
