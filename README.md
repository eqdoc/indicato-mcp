# indicato-mcp

[![npm](https://img.shields.io/npm/v/indicato-mcp)](https://www.npmjs.com/package/indicato-mcp)
[![licence](https://img.shields.io/npm/l/indicato-mcp)](./LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-1-brightgreen)](./package.json)

An [MCP](https://modelcontextprotocol.io) server that gives an AI assistant the 89
indicators in [indicato](https://github.com/eqdoc/indicato), and its 61 candlestick
patterns, 11 indicator events and chart patterns.

The assistant asks for an RSI; this computes one. It does not guess at the arithmetic,
and it does not hallucinate a number that looks about right. Asked whether a stock formed
an engulfing candle last week, it scans the bars and lists the dates.

## Install

```
claude mcp add indicato -- npx -y indicato-mcp
```

Or, for any client that reads a JSON config:

```json
{
  "mcpServers": {
    "indicato": {
      "command": "npx",
      "args": ["-y", "indicato-mcp"]
    }
  }
}
```

Node 18 or newer. Nothing else to configure.

Its only dependency is `indicato`. The MCP protocol is spoken directly — newline-delimited
JSON-RPC on stdin and stdout — rather than through the reference SDK, which declares two
web frameworks, CORS, OAuth PKCE and a JOSE implementation to carry transports this server
does not use. That was 88 packages behind a process that opens no socket and reads your
files.

## Where the data comes from

Nowhere. This server has no network access and no market data of its own — the same
rule the library follows. Bars arrive one of two ways:

**Inline**, for a few hundred bars:

```json
{ "indicator": "rsi", "bars": [{"o":100,"h":102,"l":99,"c":101,"v":10000}, ...] }
```

A plain array of numbers is accepted too, and treated as closes.

**From a file** on the machine running the server, for anything larger:

```json
{ "indicator": "rsi", "file": "/data/RELIANCE.csv", "params": { "n": 21 } }
```

CSV headers are matched case-insensitively against `open`/`high`/`low`/`close`/`volume`
and the usual variants — `Adj Close`, `close_price`, `LTP`, and so on. The columns
actually used come back in the response, so a wrong guess is visible rather than silent.
If the rows are newest-first and carry dates, they are reversed and you are told.

The tools that read candles (`find_candles`, `find_events`, `find_patterns`) need more
than a close. A list of closes, or a file with no open, high or low, is refused rather
than scanned: a candle whose open, high, low and close are the same number is a doji, and
the answer would be a doji on almost every bar. `find_events` and `find_patterns` also need
volume, and `find_patterns` needs a date on every bar.

## Tools

| tool | what it does |
|---|---|
| `list_indicators` | All 89, with parameters and defaults. Start here. |
| `describe_indicator` | Parameters, return shape, and whether it has a TA-Lib mode. |
| `compute` | One indicator over your bars. |
| `compute_many` | Several indicators, one read of the data. |
| `list_candles` | All 61 candlestick patterns, the curated 20 flagged. |
| `find_candles` | Scan the bars for candlestick patterns. |
| `find_events` | The 11 indicator events: a stochastic crossing out of oversold, a close through the Keltner channel, a price low on a higher RSI low. |
| `find_patterns` | Chart patterns with their state and the points and lines to draw them. |

`compute` returns the **trailing values plus a summary** — warmup index, first, last,
min, max, mean — rather than the whole series. Twenty years of daily bars through
`bollinger` is three arrays of five thousand floats, which no model needs to read to
answer a question about the last month. Pass `full: true` when you actually want
everything, and `tail: 60` when you want more than the default ten.

```json
{
  "indicator": "macd",
  "values": { "line": [4.21, 4.33, ...], "signal": [...], "hist": [...] },
  "summary": { "line": { "warmup": 33, "last": 4.33, "min": -8.1, "max": 11.4, ... } },
  "source": { "file": "/data/RELIANCE.csv", "rows": 2480, "columns": { "c": "Close" } },
  "showing": "last 10 of 2480"
}
```

## TA-Lib numbers

indicato's defaults are Wilder's and Appel's definitions written plainly. TA-Lib seeds its
averages differently and starts a bar later, so the two agree to several digits, not all
of them, and a rule that fires on a cross can fire a bar apart. If the numbers have to
match a TA-Lib scan, ask for them:

```json
{ "indicator": "rsi", "file": "/data/RELIANCE.csv", "compat": "talib" }
```

Nine indicators have it: `sma`, `rsi`, `atr`, `dmi`, `macd`, `bollinger`, `stochRsi`,
`psar` and `supertrend`. `describe_indicator` says which, and what differs for each. Asking
for it on any other indicator is an error, not a quiet fall back to the default. The result
carries `"compat": "talib"` so it is visible which numbers you were given. With
`compute_many` it can go on the call or on one item:

```json
{ "indicators": ["rsi", { "indicator": "atr", "compat": "talib" }], "bars": [...] }
```

`supertrend` has no TA-Lib function; its mode is the one Python scans write on `talib.ATR`.
`stochRsi` under `compat` takes TA-Lib's `fastk_period` as `k`, whose default there is 5, so
pass `"params": { "k": 5 }` to match `talib.STOCHRSI` defaults.

## Candles, events and chart patterns

These three scan the bars instead of computing a series. They answer in the same shape as
`compute`: counts for the whole history, then the most recent few. `tail` sets how many,
`full: true` returns everything.

**Candlestick patterns.** `find_candles` scans the 20 curated reversal and continuation
shapes by default (engulfing, hammer, morning star, three white soldiers, and so on). Pass
`"set": "all"` for all 61, or `"patterns": ["engulfing", "harami"]` for named ones.

```json
{ "file": "/data/RELIANCE.csv", "tail": 1 }
```
```json
{
  "bars": 600,
  "lastBar": { "i": 599, "date": "2026-11-12" },
  "totalHits": 183,
  "byPattern": { "engulfing": { "bull": 20, "bear": 29 }, "hammer": { "bull": 10, "bear": 0 } },
  "hits": [
    { "i": 595, "date": "2026-11-06", "pattern": "marubozu", "side": "bull", "value": 100 }
  ],
  "showing": "last 1 of 183 hits"
}
```

(Abridged: `byPattern` lists every pattern that fired. The examples here are indicato's own RELIANCE test fixture.)

`value` is TA-Lib's signed integer: 100 is a bullish shape, -100 a bearish one, 80 the weaker
equal-edge variants of Engulfing and Harami, 200 a confirmed Hikkake. The 41 patterns outside the
curated set mostly describe a candle's shape, not an event, and some fire on a fifth of all
bars (`spinningTop` 23%, `longLine` 19% over a million daily bars). That is TA-Lib's definition.
They are there for completeness; `list_candles` shows which are which.

**Indicator events.** `find_events` returns what happened on one bar, never a state a stock
sits in. Eleven signals: `stoch cci willr aroon keltner rsidiv macddiv vol52 dma200 nr7 gap`,
or pass `"signals": ["rsidiv", "dma200"]` for some of them. Each event has a bar index, date,
side and a label in words. The two divergences carry the pair of pivots joined. A divergence
is dated the bar its second pivot is confirmed, not the pivot itself, and nothing fires in
the first 60 bars.

```json
{ "i": 528, "date": "2026-07-31", "signal": "rsidiv", "side": "bull",
  "event": "Bullish RSI divergence",
  "geometry": { "p1": { "bar": 511, "date": "2026-07-08", "price": 1271.6, "indicator": 39.35 },
                "p2": { "bar": 523, "date": "2026-07-24", "price": 1249.8, "indicator": 42.39 } } }
```

**Chart patterns.** `find_patterns` looks for head and shoulders (and inverse), double tops
and bottoms, triangles, wedges, flags, pennants and cup and handle, on daily bars and the
weekly bars built from them. Each comes with a `state` (`forming`, `confirmed`, `failed`) and
the geometry to draw it:

```json
{
  "name": "Falling wedge", "side": "bull", "state": "confirmed", "timeframe": "daily",
  "formed": "2026-10-15", "formedBar": 500, "confidence": 3,
  "geometry": {
    "points": [{ "role": "upper", "d": "2026-09-04", "p": 1333 }, { "role": "lower", "d": "2026-10-13", "p": 1152.2 }],
    "lines": [{ "role": "upper", "from": { "d": "2026-09-04", "p": 1333 }, "to": { "d": "2026-10-15", "p": 1188.74 } }],
    "event": { "d": "2026-10-15", "p": 1215, "vol": 1.78 }
  }
}
```

(Abridged: a wedge has five points and two lines.)

A pattern is `confirmed` only by a close through its line on volume at least 1.25 times the
20-session mean; a break on thin volume is not reported. The result is anchored on the last bar,
and only recent detections are reported, so it answers what is on the chart now rather than
listing every pattern in twenty years. Thresholds scale to the volatility of the history you
pass, so give it the history you mean: indicato's own reference tests use the last 520 daily
bars, about two years. `state`, `weekly: false` and `geometry: false` narrow the output.

None of the three says what a pattern means for price. They describe what happened.

## Two indicators need a benchmark

`beta` and `correlation` relate one instrument to another. Pass a `benchmark` series of
the same length as the bars, or a `benchmarkFile`:

```json
{ "indicator": "beta", "file": "/data/RELIANCE.csv", "benchmarkFile": "/data/NIFTY50.csv" }
```

Lengths must match bar for bar. A mismatch is refused rather than quietly truncated —
a beta computed against a misaligned index is worse than no beta.

## Mistakes it will not let you make

A wrong parameter name is an error, not a shrug:

> `rsi` has no parameter `period`. It takes: n = 14.

A wrong indicator name suggests the right one:

> no indicator named `bollingerbands`. Did you mean: bollinger, bbWidth, bbPercent?

Both are addressed to the model, which reads the message and corrects itself.

## What it can reach

The file system, as you, and nothing else. It opens no network connection.

`file` is a path, and the thing choosing that path is a language model, which can be
talked into things by what it reads. So a file that fails to parse is not quoted back
into the error message — only fragments that look like column names survive, which
`Adj Close` does and a line of a private key does not. Files are capped at 64 MB, and
window lengths are bounded before anything is allocated.

Point it at a directory of exports and it is useful. It has no more reach than that.

## Changes

**0.2.0** moves to `indicato` 0.3.0 and exposes everything in it: `compat: "talib"` on
`compute` and `compute_many` for the nine indicators that have it, and four new tools,
`list_candles`, `find_candles`, `find_events` and `find_patterns`. Two bugs found on the way are
fixed: `supertrend`'s `up` line came back as nulls instead of true and false, and a client that
wrote a request and closed stdin straight away lost the reply to any call that read a file.
The `indicato` dependency is now pinned to an exact version and the lockfile is committed.

**0.1.1** and earlier: the four indicator tools.

## Licence

MIT.
