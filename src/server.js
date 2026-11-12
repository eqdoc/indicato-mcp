#!/usr/bin/env node
/*
 * stdio MCP server. The transport is thin on purpose — everything interesting is in
 * tools.js, which can be called without a client.
 */
import { createServer } from "./rpc.js";
import { tools } from "./tools.js";
import { NAMES, COMPAT_NAMES } from "./manifest.js";
import { CANDLE_PATTERNS, CURATED_CANDLES, EVENT_SIGNALS } from "indicato";
import { pathToFileURL } from "node:url";
import { readFileSync, realpathSync } from "node:fs";

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

const EVENT_KEYS = Object.keys(EVENT_SIGNALS);

const BARS_INPUT = {
  bars: {
    type: "array",
    description:
      "OHLCV bars, oldest first: [{o,h,l,c,v}, ...]. A plain array of numbers is " +
      "accepted and treated as closes. Use `file` instead for anything large.",
    items: { type: ["object", "number"] },
  },
  file: {
    type: "string",
    description:
      "Path to a CSV or JSON file of bars on the machine running this server. " +
      "CSV headers are matched case-insensitively against open/high/low/close/volume " +
      "and common variants; the columns actually used are reported back.",
  },
  tail: {
    type: "integer",
    description: "How many trailing values to return. Default 10.",
    minimum: 1,
  },
  full: {
    type: "boolean",
    description:
      "Return every value instead of the tail. Only for short series — a long history " +
      "produces thousands of numbers.",
  },
};

const COMPAT_INPUT = {
  type: "string",
  enum: ["talib"],
  description:
    `Use TA-Lib 0.7.1's arithmetic and first bar instead of indicato's defaults. Only ${COMPAT_NAMES.join(", ")} ` +
    "have it; naming it on any other indicator is an error. describe_indicator says what differs.",
};

/* The scanners all read the same two sources and take the same two output controls. */
const SCAN_INPUT = {
  bars: {
    ...BARS_INPUT.bars,
    description:
      "OHLCV bars, oldest first: [{o,h,l,c,v}, ...], with a `date` on each where the date should come back. " +
      "A list of closes is refused: these tools read the open, high and low.",
  },
  file: BARS_INPUT.file,
  tail: {
    type: "integer",
    description: "How many of the most recent results to return. Default 10. Counts cover everything regardless.",
    minimum: 1,
  },
  full: { type: "boolean", description: "Return every result instead of the most recent few." },
};

const DEFINITIONS = [
  {
    name: "list_indicators",
    description:
      `List the ${NAMES.length} available indicators with their parameters and defaults. ` +
      "Start here when you do not know the exact name.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional substring filter on the name." },
      },
    },
  },
  {
    name: "describe_indicator",
    description: "Parameters, defaults and return shape for one indicator.",
    inputSchema: {
      type: "object",
      properties: { indicator: { type: "string", description: "Indicator name, e.g. `rsi`." } },
      required: ["indicator"],
    },
  },
  {
    name: "compute",
    description:
      "Compute one indicator over bars. Returns the trailing values plus a summary " +
      "(warmup index, first, last, min, max, mean) so the whole series need not be read. " +
      "This server does not fetch market data: supply it as `bars` or point at a `file`.",
    inputSchema: {
      type: "object",
      properties: {
        indicator: { type: "string", description: "Indicator name, e.g. `rsi`, `macd`, `supertrend`." },
        params: {
          type: "object",
          description:
            "Named parameters, e.g. {\"n\": 21}. Omit for defaults. An unrecognised name " +
            "is an error rather than being ignored.",
          additionalProperties: true,
        },
        compat: COMPAT_INPUT,
        ...BARS_INPUT,
      },
      required: ["indicator"],
    },
  },
  {
    name: "compute_many",
    description:
      "Compute several indicators over the same bars in one call. Prefer this over " +
      "repeated `compute` calls on the same data.",
    inputSchema: {
      type: "object",
      properties: {
        indicators: {
          type: "array",
          description:
            "Names, or objects: [\"rsi\", {\"indicator\":\"ema\",\"params\":{\"n\":50}}]. An object " +
            "may carry its own `compat`.",
          items: { type: ["string", "object"] },
        },
        compat: {
          ...COMPAT_INPUT,
          description:
            COMPAT_INPUT.description + " Applies to every indicator in the call; one without a TA-Lib mode comes " +
            "back in `errors` rather than being computed the other way.",
        },
        ...BARS_INPUT,
      },
      required: ["indicators"],
    },
  },
  {
    name: "list_candles",
    description:
      `List the ${Object.keys(CANDLE_PATTERNS).length} candlestick patterns (all of TA-Lib's), flagging the ` +
      `${CURATED_CANDLES.length} curated reversal and continuation shapes that find_candles scans by default.`,
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional substring filter on the name." },
        curated: { type: "boolean", description: "true for only the curated 20, false for only the other 41." },
      },
    },
  },
  {
    name: "find_candles",
    description:
      "Scan bars for candlestick patterns. Scans the 20 curated patterns by default, all 61 with set: \"all\", or " +
      "the names you give. Returns counts per pattern and the most recent hits, each with its bar index, date (if " +
      "the data has one), side (bull or bear) and TA-Lib's signed value. Needs open, high and low, so not a list of closes.",
    inputSchema: {
      type: "object",
      properties: {
        set: {
          type: "string",
          enum: ["curated", "all"],
          description: "\"curated\" (default): 20 reversal and continuation shapes. \"all\": all 61, including the indecision shapes that fire on a large share of bars.",
        },
        patterns: {
          type: "array",
          items: { type: "string" },
          description: "Specific pattern names, e.g. [\"engulfing\", \"morningStar\"]. Overrides `set`. See list_candles.",
        },
        ...SCAN_INPUT,
      },
    },
  },
  {
    name: "find_events",
    description:
      "Find indicator events: things that happened on one bar, never a state. " +
      `The ${EVENT_KEYS.length} signals: ${EVENT_KEYS.join(", ")}. Returns counts per signal and the most recent events, each with bar index, date ` +
      "(if the data has one), side and a plain-words label; divergences carry the two pivots joined. " +
      "Needs open, high, low and volume.",
    inputSchema: {
      type: "object",
      properties: {
        signals: {
          type: "array",
          items: { type: "string", enum: EVENT_KEYS },
          description: "Limit to these signals. Default: all eleven.",
        },
        ...SCAN_INPUT,
      },
    },
  },
  {
    name: "find_patterns",
    description:
      "Find chart patterns (head and shoulders and its inverse, double top and bottom, triangles, wedges, flags and " +
      "pennants, cup and handle) on the daily bars and the weekly bars built from them. Each comes with its state " +
      "(forming, confirmed or failed) and the geometry to draw it: dated points and lines. Every bar needs a date and " +
      "volume. Anchored on the last bar, so it answers what is on the chart now.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "array",
          items: { type: "string", enum: ["forming", "confirmed", "failed"] },
          description: "Only patterns in these states. Counts still cover all.",
        },
        weekly: { type: "boolean", description: "Also look for patterns on weekly bars. Default true." },
        geometry: { type: "boolean", description: "Include points and lines. Default true; false for a short list." },
        ...SCAN_INPUT,
      },
    },
  },
];

export const server = createServer({
  name: "indicato-mcp",
  version: VERSION,
  tools,
  definitions: DEFINITIONS,
});

export { DEFINITIONS };

/* Only listen when run as a program, so the tests can import this module without it
 * seizing stdin.
 *
 * Both sides have to be resolved through symlinks before they are compared. npm installs
 * a bin as a link — node_modules/.bin/indicato-mcp -> ../indicato-mcp/src/server.js — so
 * `process.argv[1]` is the link while `import.meta.url` is its target. Comparing them raw
 * is false for every real installation and true only when the file is run by its own
 * path, which is exactly what a test does. It passes everywhere except in use. */
const entry = process.argv[1];
if (entry) {
  let invoked;
  try {
    invoked = pathToFileURL(realpathSync(entry)).href;
  } catch {
    invoked = pathToFileURL(entry).href;
  }
  if (invoked === import.meta.url) server.listen();
}
