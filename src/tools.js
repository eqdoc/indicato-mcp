/*
 * The tool implementations, kept apart from the transport so they can be tested by
 * calling them directly.
 *
 * One decision runs through all of this: a model should not be handed five thousand
 * numbers. A 20-year daily history through `bollinger` is three arrays of 5,000
 * floats, which is both useless to read and expensive to carry. So `compute` returns
 * the tail plus a summary by default, and the caller has to ask for the whole series
 * on purpose.
 */
import { MANIFEST, NAMES, get, suggest, TA } from "./manifest.js";
import { normaliseInline, orderOldestFirst, loadFile } from "./bars.js";

const round = (v) => (typeof v === "number" && Number.isFinite(v) ? +v.toFixed(6) : null);

function summarise(series) {
  const vals = series.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!vals.length) return { defined: 0 };
  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of vals) { if (v < min) min = v; if (v > max) max = v; sum += v; }
  return {
    defined: vals.length,
    warmup: series.findIndex((v) => v !== null && v !== undefined && Number.isFinite(v)),
    first: round(vals[0]),
    last: round(vals[vals.length - 1]),
    min: round(min),
    max: round(max),
    mean: round(sum / vals.length),
  };
}

function shape(out, tail, full) {
  const cut = (a) => (full ? a.map(round) : a.slice(-tail).map(round));
  if (Array.isArray(out)) {
    return { values: cut(out), summary: summarise(out) };
  }
  const values = {}, summary = {};
  for (const [k, v] of Object.entries(out)) {
    if (!Array.isArray(v)) { values[k] = v; continue; }
    values[k] = cut(v);
    summary[k] = summarise(v);
  }
  return { values, summary };
}

async function resolveBars(args) {
  if (args.file) {
    const loaded = await loadFile(args.file);
    const ordered = orderOldestFirst(loaded.bars);
    return {
      bars: ordered.bars,
      source: {
        file: args.file,
        format: loaded.format,
        rows: ordered.bars.length,
        columns: loaded.columns,
        skippedRows: loaded.skipped || undefined,
        reversedToOldestFirst: ordered.reversed || undefined,
        orderChecked: ordered.checked,
      },
    };
  }
  if (args.bars) {
    const { bars, fromCloses } = normaliseInline(args.bars);
    const ordered = orderOldestFirst(bars);
    return {
      bars: ordered.bars,
      source: {
        inline: true,
        rows: bars.length,
        fromClosesOnly: fromCloses || undefined,
        reversedToOldestFirst: ordered.reversed || undefined,
        orderChecked: ordered.checked,
      },
    };
  }
  throw new Error("pass either `bars` (inline) or `file` (a path on this machine)");
}

/* Parameters arrive from a model, so they arrive as whatever the model felt like
 * sending. A period of 1e12 is not an attack so much as a typo, but it allocates until
 * the process dies either way, and a fractional period silently produces a series that
 * is neither the 14 nor the 15 anyone meant.
 *
 * Telling a window from a multiplier cannot be done from the default. `mult = 2` is a
 * whole number and 1.5 is a perfectly good value for it; `n = 20` is a whole number and
 * 14.5 is not. The names are the only thing that separates them, so the windows are
 * named explicitly and everything else — mult, sigma, offset, step, and the single
 * letters, which are ambiguous — is left to the magnitude check alone.
 *
 * A list that is too eager is worse than no list: it rejects calls that were fine. */
const MAX_MAGNITUDE = 1e6;
const WINDOWS = new Set([
  "n", "fast", "slow", "signal", "short", "long", "smooth", "cycle", "conv", "base",
  "spanB", "atrLen", "rsiLen", "rankLen", "streakLen", "barsPerYear", "sig",
]);

function checkParam(entry, p, value) {
  if (typeof value !== "number") {
    if (typeof p.default === "number") {
      throw new Error(`${entry.name}: \`${p.name}\` must be a number, got ${typeof value}.`);
    }
    return value;
  }
  if (!Number.isFinite(value)) {
    throw new Error(`${entry.name}: \`${p.name}\` must be a finite number.`);
  }
  if (Math.abs(value) > MAX_MAGNITUDE) {
    throw new Error(
      `${entry.name}: \`${p.name}\` is ${value}, beyond the ${MAX_MAGNITUDE} limit. ` +
      `A window that size cannot be computed from any realistic history.`
    );
  }
  if (WINDOWS.has(p.name) && (!Number.isInteger(value) || value < 1)) {
    throw new Error(
      `${entry.name}: \`${p.name}\` is a window length — it must be a whole number of ` +
      `1 or more, got ${value}.`
    );
  }
  return value;
}

/* Positional arguments, from a named object, against the parsed signature. Extra keys
 * are an error rather than a shrug: a silently ignored `period` is how someone ends up
 * charting a 14-day RSI they asked to be 21. */
function orderParams(entry, given = {}) {
  const known = new Set(entry.params.map((p) => p.name));
  const unknown = Object.keys(given).filter((k) => !known.has(k));
  if (unknown.length) {
    throw new Error(
      `${entry.name} has no parameter ${unknown.map((u) => `\`${u}\``).join(", ")}. ` +
      (entry.params.length
        ? `It takes: ${entry.params.map((p) => p.name + (p.required ? "" : ` = ${JSON.stringify(p.default)}`)).join(", ")}.`
        : "It takes no parameters beyond the bars.")
    );
  }
  const args = [];
  let seen = false;
  for (let i = entry.params.length - 1; i >= 0; i--) {
    const p = entry.params[i];
    const has = Object.prototype.hasOwnProperty.call(given, p.name);
    if (has) seen = true;
    if (seen) args[i] = has ? checkParam(entry, p, given[p.name]) : p.default;
  }
  return args.filter((_, i) => i in args);
}

function callOne(entry, bars, params, tail, full, benchmark) {
  const fn = TA[entry.name];
  const closes = () => bars.map((b) => b.c);
  const args = [];
  if (entry.input === "bars") args.push(bars);
  else args.push(closes());
  if (entry.input === "pair") {
    if (!benchmark) {
      throw new Error(
        `${entry.name} compares two series. Pass \`benchmark\` (an index or second ` +
        `instrument) alongside the bars — inline, or as \`benchmarkFile\`.`
      );
    }
    if (benchmark.length !== bars.length) {
      throw new Error(
        `${entry.name} needs both series aligned bar for bar: ${bars.length} bars ` +
        `against ${benchmark.length} benchmark values. Trim them to the same dates first.`
      );
    }
    args.push(benchmark);
  }
  const out = fn(...args, ...orderParams(entry, params));
  return { indicator: entry.name, ...shape(out, tail, full) };
}

async function resolveBenchmark(args) {
  if (args.benchmarkFile) {
    const loaded = await loadFile(args.benchmarkFile);
    return orderOldestFirst(loaded.bars).bars.map((b) => b.c);
  }
  if (args.benchmark) {
    const { bars } = normaliseInline(args.benchmark);
    return orderOldestFirst(bars).bars.map((b) => b.c);
  }
  return null;
}

export const tools = {
  list_indicators({ search } = {}) {
    const rows = NAMES.map((n) => MANIFEST.get(n)).filter((e) => {
      if (!search) return true;
      const q = String(search).toLowerCase();
      return e.name.toLowerCase().includes(q);
    });
    return {
      count: rows.length,
      note: "Call describe_indicator for parameters, or compute directly — defaults are used when params are omitted.",
      indicators: rows.map((e) => ({
        name: e.name,
        needs: e.input === "pair" ? "bars + benchmark" : e.input,
        returns: e.output === "object" ? e.lines : "series",
        params: e.params.map((p) => (p.required ? p.name : `${p.name}=${JSON.stringify(p.default)}`)),
      })),
    };
  },

  describe_indicator({ indicator }) {
    const e = get(indicator);
    if (!e) {
      const near = suggest(indicator);
      throw new Error(
        `no indicator named \`${indicator}\`.` + (near.length ? ` Did you mean: ${near.join(", ")}?` : "")
      );
    }
    return {
      name: e.name,
      input: e.input === "bars"
        ? "OHLCV bars, oldest first"
        : e.input === "pair"
          ? "two aligned series: the bars, plus a `benchmark` of equal length"
          : "a single series; close is used when bars are supplied",
      parameters: e.params.map((p) => ({
        name: p.name,
        required: p.required,
        default: p.required ? undefined : p.default,
      })),
      returns: e.output === "object"
        ? { type: "object", lines: e.lines }
        : { type: "array", note: "same length as the input, null through the warmup" },
    };
  },

  async compute(args) {
    const e = get(args.indicator);
    if (!e) {
      const near = suggest(args.indicator);
      throw new Error(
        `no indicator named \`${args.indicator}\`.` +
        (near.length ? ` Did you mean: ${near.join(", ")}?` : " Call list_indicators to see all 89.")
      );
    }
    const { bars, source } = await resolveBars(args);
    const tail = args.tail ?? 10;
    const result = callOne(e, bars, args.params, tail, args.full === true, await resolveBenchmark(args));
    return {
      ...result,
      params: args.params ?? "defaults",
      source,
      showing: args.full ? `all ${bars.length} values` : `last ${Math.min(tail, bars.length)} of ${bars.length}`,
    };
  },

  /* One read of the data, several indicators off it. A model comparing RSI against
   * MACD against ATR would otherwise send the same 5,000 bars three times. */
  async compute_many(args) {
    const { bars, source } = await resolveBars(args);
    const tail = args.tail ?? 10;
    const benchmark = await resolveBenchmark(args);
    const results = [], errors = [];
    for (const req of args.indicators ?? []) {
      const name = typeof req === "string" ? req : req.indicator;
      const params = typeof req === "string" ? undefined : req.params;
      const e = get(name);
      if (!e) { errors.push({ indicator: name, error: `unknown indicator${suggest(name).length ? `; did you mean ${suggest(name)[0]}?` : ""}` }); continue; }
      try {
        results.push(callOne(e, bars, params, tail, args.full === true, benchmark));
      } catch (err) {
        errors.push({ indicator: name, error: err.message });
      }
    }
    return { source, showing: `last ${Math.min(tail, bars.length)} of ${bars.length}`, results, errors: errors.length ? errors : undefined };
  },
};
