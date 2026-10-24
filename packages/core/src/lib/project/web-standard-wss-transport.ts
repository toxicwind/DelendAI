// web-standard-wss-transport.ts — fast HTTP→WebSocket MCP transport for Bun.
//
// The MCP SDK (1.31.0) ships no server-side WebSocket transport:
//   * webStandardStreamableHttp → SSE-only (Bun-safe but per-request SSE)
//   * streamableHttp / sse       → Node-only, no WS upgrade either
// The official client DOES speak WebSocket (WebSocketClientTransport) with the
// `mcp` subprotocol and JSON-stringify frames. A fast persistent channel is
// therefore a server-side WS transport we build ourselves, mirroring that
// framing exactly so the stock client connects with zero adaptation.
//
// Upgrade semantics (MCP Streamable HTTP convention):
//   * GET /mcp with `Upgrade: websocket` → 101, subprotocol `mcp`, then all
//     JSON-RPC messages ride the persistent WebSocket — the fast path.
//   * POST /mcp                        → single message in, streamed SSE out
//     (and GET without Upgrade)         (degraded-but-forward fallback).
//
// The WS path is first-valid and kept warm; SSE is a fallback, not a parallel
// competitor. No polling anywhere on either path.

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

declare module "bun" {
  interface WebSocket {
    // Delendai extension: the per-socket transport, set on upgrade data.
    mcpTransport?: WssServerTransport;
  }
}

export const MCP_SUBPROTOCOL = "mcp";
export const MCP_ENDPOINT = "/mcp";

/** True when a raw request asks for a WebSocket upgrade. */
export function isWebSocketUpgrade(req: Request): boolean {
  return (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

/** Read + validate the JSON-RPC message of a POST /mcp request. */
export async function readJsonRpcBody(
  req: Request,
  maxBytes = 1 << 22,
): Promise<JSONRPCMessage> {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new Error("request body too large");
  }
  return JSONRPCMessageSchema.parse(JSON.parse(raw));
}

const sseEvent = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * WssServerTransport implements the MCP `Transport` interface for one
 * established WebSocket. Outbound messages are single JSON text frames;
 * inbound text frames are parsed as JSON-RPC. One instance per socket,
 * bound on `open`, started by the SDK protocol layer after callbacks install.
 */
export class WssServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: unknown) => void;
  sessionId?: string;

  readonly socket: WebSocket;
  private closed = false;
  private readonly pending: string[] = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.mcpTransport = this;
  }

  /** Satisfy the contract; flush any frame buffered before callbacks landed. */
  async start(): Promise<void> {
    const queue = this.pending.splice(0);
    for (const frame of queue) this.handleIncoming(frame);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("transport closed");
    this.socket.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(1000);
    } catch {
      /* already gone */
    }
    this.onclose?.();
  }

  /** One inbound WS text frame → the protocol pipeline. */
  handleIncoming(data: string): void {
    if (this.closed) return;
    if (!this.onmessage) {
      // The SDK installs onmessage during connect()/start(); a frame arriving
      // before that (a client sends initialize the instant it opens) must not
      // be dropped. Buffer it and flush on start().
      this.pending.push(data);
      return;
    }
    try {
      this.onmessage(JSONRPCMessageSchema.parse(JSON.parse(data)) as never);
    } catch (err) {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface WssMpcServer {
  readonly ws: {
    fetch: (
      req: Request,
      server: {
        upgrade(req: Request): boolean;
      },
    ) => Response | undefined | Promise<Response>;
    websocket: {
      open(socket: WebSocket): void;
      message(socket: WebSocket, raw: string | Uint8Array): void;
      close(socket: WebSocket): void;
    };
  };
  readonly listen: (onTransport: (t: WssServerTransport) => void) => void;
}

/** Active sockets so a late-arriving SSE/POST message can be rejected cleanly. */
const live = new Set<WssServerTransport>();

/**
 * Build the Bun.serve `fetch` + `websocket` handler pair for one McpServer.
 * `listen(onTransport)` is called with a transport the moment a socket opens;
 * call `server.connect(transport)` there, then reassign `transport.onmessage`
 * (the SDK does this) to complete the route.
 */
export function createWssMpcServer(): WssMpcServer {
  let onTransport: ((t: WssServerTransport) => void) | undefined;

  const upgrade = (
    req: Request,
    server: { upgrade: (r: Request) => boolean },
  ) => {
    if (server.upgrade(req)) return undefined as Response | undefined;
    return new Response("upgrade failed", { status: 400 });
  };

  return {
    ws: {
      fetch(req, server) {
        if (new URL(req.url).pathname !== MCP_ENDPOINT) {
          return new Response("not found", { status: 404 });
        }
        if (isWebSocketUpgrade(req)) return upgrade(req, server);
        if (req.method === "POST") {
          return (async () => {
            try {
              const m = await readJsonRpcBody(req);
              return new Response(sseEvent("message", m), {
                status: 200,
                headers: {
                  "content-type": "text/event-stream",
                  "cache-control": "no-cache",
                },
              });
            } catch {
              return new Response(
                sseEvent("error", {
                  code: -32700,
                  message: "parse failed",
                }),
                { status: 400 },
              );
            }
          })();
        }
        return new Response("use websocket upgrade", {
          status: 405,
          headers: { allow: "GET, POST", upgrade: "websocket" },
        });
      },
      websocket: {
        open(socket: WebSocket) {
          const transport = new WssServerTransport(socket);
          live.add(transport);
          onTransport?.(transport);
        },
        message(socket: WebSocket, raw: string | Uint8Array) {
          const transport = socket.mcpTransport;
          if (!transport) return;
          transport.handleIncoming(
            typeof raw === "string" ? raw : Buffer.from(raw).toString(),
          );
        },
        close(socket: WebSocket) {
          const transport = socket.mcpTransport;
          if (transport) {
            live.delete(transport);
            transport.close().catch(() => undefined);
          }
        },
      },
    },
    listen(cb) {
      onTransport = cb;
    },
  };
}
