/*
 * MCP over stdio, spoken directly.
 *
 * The official SDK does this and more, but the "more" is the problem: it declares two
 * web frameworks, CORS, OAuth PKCE and a JOSE implementation, because it also carries
 * the HTTP and SSE transports. Installing it pulled 88 packages behind this server.
 *
 * None of them run here. This process speaks newline-delimited JSON-RPC 2.0 on stdin
 * and stdout and opens no socket. Against that, 88 packages is a supply chain to
 * inherit for nothing — and this is a package people will run through `npx -y`, on
 * their own machine, pointed at their own files.
 *
 * So the transport is written out. It is small because the surface genuinely is:
 * initialize, tools/list, tools/call, ping. The wire format is stable and versioned,
 * and the version is negotiated below rather than assumed.
 *
 * One rule holds the whole thing together: stdout carries protocol and nothing else.
 * A stray console.log corrupts the stream and the client sees a dead server. Diagnostics
 * go to stderr.
 */

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = SUPPORTED[0];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export function createServer({ name, version, tools, definitions }) {
  let initialised = false;

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  function reply(id, result) {
    if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, result });
  }

  function fail(id, code, message) {
    if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function handle(msg) {
    const { id, method, params } = msg;

    if (msg.jsonrpc !== "2.0" || typeof method !== "string") {
      return fail(id, INVALID_REQUEST, "not a JSON-RPC 2.0 request");
    }

    switch (method) {
      case "initialize": {
        /* Echo the client's version when it is one we know, so an older client is not
         * forced forward. Otherwise answer with ours and let it decide. */
        const asked = params?.protocolVersion;
        initialised = true;
        return reply(id, {
          protocolVersion: SUPPORTED.includes(asked) ? asked : LATEST,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
        });
      }

      /* Notifications carry no id and take no response, including ones we do not know:
       * an unknown notification is ignored by design, not answered with an error. */
      case "notifications/initialized":
        return;

      case "ping":
        return reply(id, {});

      case "tools/list":
        return reply(id, { tools: definitions });

      case "tools/call": {
        const fn = tools[params?.name];
        if (!fn) return fail(id, METHOD_NOT_FOUND, `unknown tool: ${params?.name}`);
        try {
          const result = await fn(params.arguments ?? {});
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        } catch (err) {
          /* A bad argument is the model's mistake to correct, not a transport failure.
           * It comes back as tool content flagged isError, so the message is readable
           * and the conversation continues. */
          return reply(id, { content: [{ type: "text", text: err.message }], isError: true });
        }
      }

      default:
        if (id === undefined || id === null) return;
        return fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  }

  function listen(input = process.stdin) {
    let buffer = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "invalid JSON" } });
          continue;
        }
        /* Each message is handled as it arrives; a slow file read does not block the
         * next request, and an unhandled rejection must not take the process down. */
        Promise.resolve(handle(msg)).catch((err) => {
          fail(msg?.id, INTERNAL_ERROR, err?.message ?? "internal error");
        });
      }
    });
    input.on("end", () => process.exit(0));
  }

  return { handle, listen, isInitialised: () => initialised };
}
