#!/usr/bin/env node
/*
 * stdio MCP server. The transport is thin on purpose — everything interesting is in
 * tools.js, which can be called without a client.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools.js";
import { NAMES } from "./manifest.js";

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
            "Names, or objects: [\"rsi\", {\"indicator\":\"ema\",\"params\":{\"n\":50}}].",
          items: { type: ["string", "object"] },
        },
        ...BARS_INPUT,
      },
      required: ["indicators"],
    },
  },
];

const server = new Server(
  { name: "indicato-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: DEFINITIONS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fn = tools[req.params.name];
  if (!fn) {
    return { isError: true, content: [{ type: "text", text: `unknown tool: ${req.params.name}` }] };
  }
  try {
    const result = await fn(req.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    /* Errors go back as content, not as a protocol failure, so the model can read the
     * message and correct itself rather than seeing the call disappear. */
    return { isError: true, content: [{ type: "text", text: err.message }] };
  }
});

await server.connect(new StdioServerTransport());
