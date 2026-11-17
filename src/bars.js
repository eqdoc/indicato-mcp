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
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

/* A file this server is pointed at is not necessarily a file of prices.
 *
 * `file` is a path, and the thing choosing that path is a language model, which can be
 * talked into things by whatever it has been reading. Three layers keep an untrusted
 * path from turning into file disclosure:
 *
 *   1. Before touching the filesystem, paths are restricted to tabular/JSON extensions
 *      (.csv, .tsv, .txt, .json), hidden dotfiles and credential directories (.ssh,
 *      .aws, .gnupg, .config, .env, ...) are refused, and when a root directory is
 *      configured (--root or INDICATO_ROOT), symlinks are resolved and confined inside
 *      that root.
 *   2. After reading, neither CSV headers nor parse failures quote arbitrary file text
 *      back. Only short tokens shaped like column names survive into `source.columns`
 *      or error diagnostics, and JSON syntax errors do not echo V8's input snippet.
 *   3. Date columns only carry values that actually parse as dates or epochs, so prose
 *      or secrets in a text column never ride out in `lastBar.date` or scan hits. */
const COLUMN_LIKE = /^[A-Za-z0-9][A-Za-z0-9 ._%()*#-]{0,31}$/;
const DATE_LIKE = /^[0-9A-Za-z:/., +_-]{1,40}$/;
const EPOCH_LIKE = /^\d{9,14}(?:\.\d+)?$/;
export const MAX_BYTES = 64 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = new Set([".csv", ".tsv", ".txt", ".json"]);

const SENSITIVE_DIRS = new Set([
  ".ssh", ".aws", ".gnupg", ".config", ".docker", ".kube", ".azure",
  ".gcloud", ".pki", ".npm", ".netrc", ".password-store", ".vault", ".git",
]);
const SYSTEM_PREFIXES = ["/proc/", "/sys/", "/dev/"];

let configuredRoot = null;

export function setAllowedRoot(dir) {
  configuredRoot = dir ? resolve(dir) : null;
}

function activeRoot() {
  if (configuredRoot) return configuredRoot;
  const env = process.env.INDICATO_ROOT?.trim();
  return env || null;
}

function isWithinRoot(target, root) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function checkPathRestrictions(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  for (const prefix of SYSTEM_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.includes(`/private${prefix}`)) {
      throw new Error("refusing to read from system virtual filesystem");
    }
  }
  const base = basename(filePath);
  if (base.startsWith(".") && base !== "." && base !== "..") {
    throw new Error("refusing to read hidden file; expected a .csv, .tsv, .txt or .json export");
  }
  const segments = normalized.split("/").filter(Boolean);
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (SENSITIVE_DIRS.has(lower) || lower.startsWith(".env")) {
      throw new Error("refusing to read from restricted directory or credential path");
    }
  }
  const ext = extname(base).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      "unsupported file extension; pass a .csv, .tsv, .txt or .json file of bars"
    );
  }
}

function cleanFsError(err, fallback) {
  const code = err?.code;
  if (code === "ENOENT") return new Error("file not found");
  if (code === "EACCES" || code === "EPERM") return new Error("permission denied");
  if (code === "EISDIR") return new Error("path is not a file");
  if (code === "ENOTDIR") return new Error("invalid directory component in file path");
  return new Error(fallback);
}

async function resolveSafePath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("file path must be a non-empty string");
  }
  if (rawPath.includes("\0")) {
    throw new Error("invalid file path");
  }

  const allowAny = process.env.INDICATO_ALLOW_ANY === "1";
  if (!allowAny) {
    checkPathRestrictions(rawPath);
  }

  const root = activeRoot();
  if (root) {
    const rootResolved = resolve(root);
    let rootReal;
    try {
      rootReal = await realpath(rootResolved);
    } catch {
      throw new Error("configured root directory is not accessible");
    }

    const lexCandidate = resolve(rootResolved, rawPath);
    const lexInside =
      isWithinRoot(lexCandidate, rootResolved) ||
      isWithinRoot(resolve(rootReal, rawPath), rootReal);

    if (!lexInside && !isAbsolute(rawPath)) {
      throw new Error("file path is outside the allowed root directory");
    }

    let targetReal;
    try {
      targetReal = await realpath(lexCandidate);
    } catch (err) {
      if (!lexInside) {
        throw new Error("file path is outside the allowed root directory");
      }
      throw cleanFsError(err, "unable to access file");
    }
    if (!isWithinRoot(targetReal, rootReal)) {
      throw new Error(
        lexInside
          ? "file path escapes the allowed root directory"
          : "file path is outside the allowed root directory"
      );
    }
    if (!allowAny) {
      checkPathRestrictions(targetReal);
    }
    return targetReal;
  }

  let targetReal;
  try {
    targetReal = await realpath(resolve(rawPath));
  } catch (err) {
    throw cleanFsError(err, "unable to access file");
  }
  if (!allowAny) {
    checkPathRestrictions(targetReal);
  }
  return targetReal;
}

function cleanHeaderCell(h) {
  return String(h).trim().replace(/^"|"$/g, "").trim();
}

function safeColumnName(raw) {
  const cleaned = cleanHeaderCell(raw);
  return cleaned && COLUMN_LIKE.test(cleaned) ? cleaned : "(redacted)";
}

function safeColumns(header) {
  const kept = header
    .map(cleanHeaderCell)
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
  const cleaned = header.map(cleanHeaderCell);
  const norm = cleaned.map((h) => h.toLowerCase());
  const map = {};
  const used = new Set();

  /* Pass 1: exact normalized alias match, so `Close` beats `Adj Close` when both exist. */
  for (const [key, names] of Object.entries(ALIASES)) {
    const idx = norm.findIndex((h, i) => !used.has(i) && names.includes(h));
    if (idx !== -1) {
      map[key] = idx;
      used.add(idx);
    }
  }

  /* Pass 2: whole-word token match on column-shaped headers only, for multi-letter
   * aliases (>= 3 chars) so short substrings like `dt` never match `width` or prose. */
  for (const [key, names] of Object.entries(ALIASES)) {
    if (key in map) continue;
    const wordAliases = new Set(names.filter((n) => n.length >= 3 && !n.includes(" ")));
    const idx = norm.findIndex((h, i) => {
      if (used.has(i) || !COLUMN_LIKE.test(cleaned[i])) return false;
      const tokens = h.split(/[\s_.\-()/*#%]+/).filter(Boolean);
      return tokens.some((tok) => wordAliases.has(tok));
    });
    if (idx !== -1) {
      map[key] = idx;
      used.add(idx);
    }
  }
  return map;
}

/* A CSV/TSV parser that handles quoted fields and nothing else. Anything more elaborate
 * would be a dependency, and this reads price data, not arbitrary documents. */
function splitRow(line, sep = ",") {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur); cur = ""; }
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

function plausibleDate(s) {
  if (!s || !DATE_LIKE.test(s)) return false;
  if (EPOCH_LIKE.test(s)) return true;
  return Number.isFinite(Date.parse(s));
}

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) throw new Error("the file is empty");

  const sep = !lines[0].includes(",") && lines[0].includes("\t") ? "\t" : ",";
  const header = splitRow(lines[0], sep);
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
    const row = splitRow(lines[i], sep);
    const c = num(row[map.c]);
    if (c === null) { skipped.push(i + 1); continue; }
    const bar = {
      o: map.o !== undefined ? num(row[map.o]) ?? c : c,
      h: map.h !== undefined ? num(row[map.h]) ?? c : c,
      l: map.l !== undefined ? num(row[map.l]) ?? c : c,
      c,
    };
    if (map.v !== undefined) bar.v = num(row[map.v]) ?? 0;
    if (map.t !== undefined && row[map.t] !== undefined) {
      const rawT = cleanHeaderCell(row[map.t]);
      if (plausibleDate(rawT)) bar.t = rawT;
    }
    bars.push(bar);
  }
  if (!bars.length) throw new Error("no rows with a numeric close");

  return {
    bars,
    columns: Object.fromEntries(Object.entries(map).map(([k, i]) => [k, safeColumnName(header[i])])),
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
    if (!b || typeof b !== "object") {
      throw new Error(`bar ${i} has no numeric close`);
    }
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

export async function loadFile(rawPath) {
  const safePath = await resolveSafePath(rawPath);
  let info;
  try {
    info = await stat(safePath);
  } catch (err) {
    throw cleanFsError(err, "unable to stat file");
  }
  if (!info.isFile()) throw new Error("path is not a file");
  if (info.size > MAX_BYTES) {
    throw new Error(
      `file exceeds the ${MAX_BYTES / 1048576} MB limit. Slice the history you need first.`
    );
  }
  let text;
  try {
    text = await readFile(safePath, "utf8");
  } catch (err) {
    throw cleanFsError(err, "unable to read file");
  }
  const trimmed = text.trimStart();
  const isJsonExt = extname(safePath).toLowerCase() === ".json";
  if (isJsonExt || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("invalid JSON in bars file");
    }
    const arr = Array.isArray(json) ? json : json?.bars ?? json?.data ?? json?.candles;
    if (!Array.isArray(arr)) throw new Error("JSON file has no array of bars");
    const { bars, lacks } = normaliseInline(arr);
    return { bars, columns: null, skipped: 0, format: "json", lacks };
  }
  const csv = parseCsv(text);
  return { ...csv, format: "csv", lacks: ["o", "h", "l", "v"].filter((k) => !Object.hasOwn(csv.columns, k)) };
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
