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

/* Inline `bars` is meant for short histories; anything multi-megabyte belongs in a file.
 * Bounding a single NDJSON line before buffering stops a newline-less stream from growing
 * V8's heap without bound, and capping concurrent tool calls stops pipelined `file`
 * requests from multiplying the 64 MB file ceiling across dozens of parallel reads. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_CONCURRENT = 4;

export function createServer({
  name,
  version,
  tools,
  definitions,
  output = process.stdout,
  maxLineBytes = MAX_LINE_BYTES,
  maxConcurrent = MAX_CONCURRENT,
}) {
  let initialised = false;

  function send(msg) {
    output.write(JSON.stringify(msg) + "\n");
  }

  function reply(id, result) {
    if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, result });
  }

  function fail(id, code, message) {
    if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function handle(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return send({ jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "not a JSON-RPC 2.0 request" } });
    }
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
        const toolName = params?.name;
        const fn = typeof toolName === "string" && Object.hasOwn(tools, toolName) ? tools[toolName] : undefined;
        if (typeof fn !== "function") return fail(id, METHOD_NOT_FOUND, `unknown tool: ${String(toolName)}`);
        const args = params?.arguments ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          return fail(id, INVALID_REQUEST, "tool arguments must be an object");
        }
        try {
          const result = await fn(args);
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

  function listen(input = process.stdin, { exitOnEnd = true } = {}) {
    let buffer = "";
    let bufferBytes = 0;
    let dropping = false;
    let active = 0;
    let paused = false;
    const waiters = [];
    const inflight = new Set();

    function acquire() {
      if (active < maxConcurrent) {
        active++;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    }

    function release() {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }

    function enqueue(msg) {
      const run = async () => {
        await acquire();
        try {
          await handle(msg);
        } catch (err) {
          fail(msg?.id, INTERNAL_ERROR, err?.message ?? "internal error");
        } finally {
          release();
        }
      };
      const job = run().finally(() => {
        inflight.delete(job);
        if (paused && inflight.size <= maxConcurrent && typeof input.resume === "function") {
          paused = false;
          input.resume();
        }
      });
      inflight.add(job);
      if (!paused && inflight.size >= maxConcurrent * 4 && typeof input.pause === "function") {
        paused = true;
        input.pause();
      }
    }

    function dispatchLine(line) {
      if (!line) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "invalid JSON" } });
        return;
      }
      enqueue(msg);
    }

    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      let rest = chunk;
      while (rest.length > 0) {
        if (dropping) {
          const nl = rest.indexOf("\n");
          if (nl === -1) break;
          rest = rest.slice(nl + 1);
          dropping = false;
          continue;
        }

        const nl = rest.indexOf("\n");
        if (nl === -1) {
          const chunkBytes = Buffer.byteLength(rest, "utf8");
          if (bufferBytes + chunkBytes > maxLineBytes) {
            buffer = "";
            bufferBytes = 0;
            dropping = true;
            send({ jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: `request exceeds ${maxLineBytes} bytes` } });
            break;
          }
          buffer += rest;
          bufferBytes += chunkBytes;
          break;
        }

        const head = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        const headBytes = Buffer.byteLength(head, "utf8");
        if (bufferBytes + headBytes > maxLineBytes) {
          buffer = "";
          bufferBytes = 0;
          send({ jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: `request exceeds ${maxLineBytes} bytes` } });
          continue;
        }

        const line = (buffer + head).trim();
        buffer = "";
        bufferBytes = 0;
        dispatchLine(line);
      }
    });

    /* A client that writes its requests and closes stdin has not stopped waiting for the
     * answers. A file read is asynchronous, so exiting on end alone dropped its reply. */
    const done = new Promise((resolve) => {
      input.on("end", async () => {
        while (inflight.size > 0) {
          await Promise.allSettled([...inflight]);
        }
        resolve();
        if (exitOnEnd) process.exit(0);
      });
    });

    return done;
  }

  return { handle, listen, isInitialised: () => initialised };
}
