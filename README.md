# indicato-mcp

[![npm](https://img.shields.io/npm/v/indicato-mcp)](https://www.npmjs.com/package/indicato-mcp)
[![licence](https://img.shields.io/npm/l/indicato-mcp)](./LICENSE)

An [MCP](https://modelcontextprotocol.io) server that gives an AI assistant the 89
indicators in [indicato](https://github.com/eqdoc/indicato).

The assistant asks for an RSI; this computes one. It does not guess at the arithmetic,
and it does not hallucinate a number that looks about right.

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

## Tools

| tool | what it does |
|---|---|
| `list_indicators` | All 89, with parameters and defaults. Start here. |
| `describe_indicator` | Parameters and return shape for one. |
| `compute` | One indicator over your bars. |
| `compute_many` | Several indicators, one read of the data. |

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

## Licence

MIT.
