/*
 * Getting bars in.
 *
 * indicato does not fetch, and this server does not either. Bars arrive one of two
 * ways: inline in the tool call, or from a file on the machine the server runs on.
 * Both paths end at the same normalised `{ o, h, l, c, v }`.
 *
 * The awkward part is that nobody agrees on column names. A CSV from Yahoo has
 * `Adj Close`, one from a broker has `close_price`, one from a database export has
 * `C`. Rather than demand a mapping, the header is matched against aliases and the
 * result is reported back in the tool response, so a wrong guess is visible rather
 * than silent.
 */
import { readFile, stat } from "node:fs/promises";

/* A file this server is pointed at is not necessarily a file of prices.
 *
 * `file` is a path, and the thing choosing that path is a language model, which can be
 * talked into things by whatever it has been reading. So the failure path matters as
 * much as the happy one: an error that quotes the first line back — "no close column
 * found. Header was: ..." — turns any unreadable file into a one-line disclosure, and
 * one line of ~/.ssh/id_rsa or /etc/passwd is worth having.
 *
 * Reading the file at all is the point of the tool and stays allowed. Quoting it back
 * does not. Only fragments that look like column names survive: short, no separators,
 * no base64 runs. A private key line is one 64-character token and a passwd line is
 * full of colons and slashes; neither gets through, while `Adj Close` and
 * `close_price` do. */
const COLUMN_LIKE = /^[A-Za-z0-9 ._%()-]{1,32}$/;
const MAX_BYTES = 64 * 1024 * 1024;

function safeColumns(header) {
  const kept = header
    .map((h) => String(h).trim().replace(/^"|"$/g, ""))
    .filter((h) => h && COLUMN_LIKE.test(h))
    .slice(0, 12);
  if (!kept.length) return "none of the column names were readable as column names";
  const more = header.length > kept.length ? `, and ${header.length - kept.length} more` : "";
  return kept.join(", ") + more;
}

const ALIASES = {
  t: ["t", "time", "timestamp", "date", "datetime", "dt", "day"],
  o: ["o", "open", "open_price", "openprice", "1. open"],
  h: ["h", "high", "high_price", "highprice", "2. high"],
  l: ["l", "low", "low_price", "lowprice", "3. low"],
  c: ["c", "close", "close_price", "closeprice", "last", "ltp", "4. close", "adj close", "adjclose", "adj_close"],
  v: ["v", "vol", "volume", "qty", "quantity", "5. volume"],
};

function matchColumn(header) {
  const norm = header.map((h) => String(h).trim().toLowerCase().replace(/^"|"$/g, ""));
  const map = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    /* Exact alias first; only then a looser contains-match, so `close` beats
     * `adj close` when both are present. */
    let idx = norm.findIndex((h) => names.includes(h));
    if (idx === -1) idx = norm.findIndex((h) => names.some((n) => n.length > 1 && h.includes(n)));
    if (idx !== -1) map[key] = idx;
  }
  return map;
}

/* A CSV parser that handles quoted fields and nothing else. Anything more elaborate
 * would be a dependency, and this reads price data, not arbitrary documents. */
function splitRow(line) {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const num = (s) => {
  if (s === undefined || s === null) return null;
  const v = Number(String(s).trim().replace(/[",\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) throw new Error("the file is empty");

  const header = splitRow(lines[0]);
  const map = matchColumn(header);
  if (map.c === undefined) {
    throw new Error(
      `no close column found among the ${header.length} columns ` +
      `(${safeColumns(header)}). Expected one of: ${ALIASES.c.join(", ")}.`
    );
  }

  const bars = [];
  const skipped = [];
  for (let i = 1; i < lines.length; i++) {
    const row = splitRow(lines[i]);
    const c = num(row[map.c]);
    if (c === null) { skipped.push(i + 1); continue; }
    const bar = {
      o: map.o !== undefined ? num(row[map.o]) ?? c : c,
      h: map.h !== undefined ? num(row[map.h]) ?? c : c,
      l: map.l !== undefined ? num(row[map.l]) ?? c : c,
      c,
    };
    if (map.v !== undefined) bar.v = num(row[map.v]) ?? 0;
    if (map.t !== undefined) bar.t = String(row[map.t]).trim();
    bars.push(bar);
  }
  if (!bars.length) throw new Error("no rows with a numeric close");

  return {
    bars,
    columns: Object.fromEntries(Object.entries(map).map(([k, i]) => [k, header[i]])),
    skipped: skipped.length,
  };
}

/* Oldest-first is the library's contract and the commonest cause of a silently wrong
 * answer, because a reversed series still computes. Where dates are present they
 * settle it; otherwise the caller is trusted and told nothing was checked. */
export function orderOldestFirst(bars) {
  if (bars.length < 2 || bars[0].t === undefined) return { bars, reversed: false, checked: false };
  const first = Date.parse(bars[0].t);
  const last = Date.parse(bars[bars.length - 1].t);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return { bars, reversed: false, checked: false };
  if (first > last) return { bars: [...bars].reverse(), reversed: true, checked: true };
  return { bars, reversed: false, checked: true };
}

export function normaliseInline(input) {
  if (!Array.isArray(input) || !input.length) throw new Error("bars must be a non-empty array");

  /* A bare array of numbers is a close series; wrap it so every indicator that only
   * reads `c` still works. */
  if (typeof input[0] === "number") {
    return { bars: input.map((c) => ({ o: c, h: c, l: c, c })), fromCloses: true, lacks: ["o", "h", "l", "v"] };
  }

  const lacks = new Set();

  const bars = input.map((b, i) => {
    const c = b.c ?? b.close ?? b.Close;
    if (typeof c !== "number" || !Number.isFinite(c)) {
      throw new Error(`bar ${i} has no numeric close`);
    }
    const o = b.o ?? b.open ?? b.Open, h = b.h ?? b.high ?? b.High, l = b.l ?? b.low ?? b.Low;
    if (o === undefined) lacks.add("o");
    if (h === undefined) lacks.add("h");
    if (l === undefined) lacks.add("l");
    const out = { o: o ?? c, h: h ?? c, l: l ?? c, c };
    const v = b.v ?? b.volume ?? b.Volume;
    if (typeof v === "number") out.v = v; else lacks.add("v");
    const t = b.t ?? b.time ?? b.date ?? b.Date;
    if (t !== undefined) out.t = t;
    return out;
  });
  return { bars, fromCloses: false, lacks: [...lacks] };
}

export async function loadFile(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  if (info.size > MAX_BYTES) {
    throw new Error(
      `${path} is ${(info.size / 1048576).toFixed(0)} MB; the limit is ` +
      `${MAX_BYTES / 1048576} MB. Slice the history you need first.`
    );
  }
  const text = await readFile(path, "utf8");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const json = JSON.parse(text);
    const arr = Array.isArray(json) ? json : json.bars ?? json.data ?? json.candles;
    if (!Array.isArray(arr)) throw new Error("JSON file has no array of bars");
    const { bars, lacks } = normaliseInline(arr);
    return { bars, columns: null, skipped: 0, format: "json", lacks };
  }
  const csv = parseCsv(text);
  return { ...csv, format: "csv", lacks: ["o", "h", "l", "v"].filter((k) => !(k in csv.columns)) };
}

/* Bars from either source, oldest first, plus what the source did not supply.
 *
 * `lacks` matters to the tools that read the open, high, low or volume: where one is
 * missing it was filled from the close, and a candlestick scan over bars whose open,
 * high and low are all the close finds a doji everywhere and nothing else. Those tools
 * check `lacks` and refuse; the indicators that only read the close do not need to. */
export async function resolveBars(args) {
  if (args.file) {
    const loaded = await loadFile(args.file);
    const ordered = orderOldestFirst(loaded.bars);
    return {
      bars: ordered.bars,
      lacks: loaded.lacks,
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
    const { bars, fromCloses, lacks } = normaliseInline(args.bars);
    const ordered = orderOldestFirst(bars);
    return {
      bars: ordered.bars,
      lacks,
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

/* The calendar day of a bar's timestamp as YYYY-MM-DD, or null. The chart-pattern
 * detector builds weekly bars from dates and wants ISO days; an ISO string is taken at
 * its word (no timezone shift), anything else goes through Date and is read back in the
 * same local zone it was parsed in. */
export function isoDay(t) {
  if (typeof t === "string") {
    const m = t.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/);
    if (m && Number.isFinite(Date.parse(m[1]))) return m[1];
  }
  const ms = typeof t === "number" ? (t < 1e11 ? t * 1000 : t) : Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
