// ws-mcp-server.ts — host delendai's McpServer over Bun http→WebSocket (wss).
//
// The MCP SDK ties one McpServer to one transport, so a WebSocket server that
// wants many live clients cannot share the assembled `server`. This module
// launches Bun.serve for the /mcp endpoint and, per connection, builds a
// fresh `McpServer` and replays the already-ordered tool/prompt/resource
// registrations onto it (the materialized surface a remote client should see).
//
// The primary stdio path is untouched: `createMcpProject` still assembles the
// single server used for stdio; `serveWss` is the added "fast http→wss" mode
// used when `config.serverTransport.mode === 'wss'`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  IPromptRegistration,
  IResourceRegistration,
  IToolRegistration,
} from "../contracts/interfaces/tool-registration.interface";
import type { IWssTransportConfig } from "../contracts/interfaces/host-config.interface";
import {
  createWssMpcServer,
  WssServerTransport,
} from "./web-standard-wss-transport";

export interface IWsServeHandle {
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * Build + connect one connection's McpServer, replaying the materialized
 * tool/prompt/resource registrations onto it, then binding it to the socket's
 * transport. Node-safe (no Bun globals), so it is unit-testable and shared by
 * the thin `serveWss` Bun launcher.
 */
export function connectPerConnection(
  transport: WssServerTransport,
  handle: {
    readonly transport: IWssTransportConfig;
    readonly ordered: readonly IToolRegistration[];
    readonly prompts: readonly IPromptRegistration[];
    readonly resources: readonly IResourceRegistration[];
  },
): void {
  const conn = new McpServer({
    name: handle.transport.serverName,
    title: handle.transport.title ?? "DelendAI",
    version: handle.transport.serverVersion,
  });
  void (async () => {
    try {
      for (const registration of handle.ordered) {
        await registration.register(conn);
      }
      for (const prompt of handle.prompts) await prompt.register(conn);
      for (const resource of handle.resources) {
        if (!resource.id.startsWith("resource:")) {
          await resource.register(conn);
        }
      }
      await conn.connect(transport);
    } catch (err) {
      transport.onerror?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();
}

/**
 * Launch the http→wss MCP endpoint. Every WebSocket upgrade on `/mcp` gets a
 * fresh McpServer bound to that socket's transport, with the tool/prompt/
 * resource registrations replayed on it (see `connectPerConnection`).
 */
export async function serveWss(
  handle: {
    readonly transport: IWssTransportConfig;
    readonly ordered: readonly IToolRegistration[];
    readonly prompts: readonly IPromptRegistration[];
    readonly resources: readonly IResourceRegistration[];
  },
  deps: {
    /** Injectable for tests; defaults to Bun.serve. Must close via `.stop()`. */
    readonly serve?: (opts: {
      hostname: string;
      port: number;
      fetch: unknown;
      websocket: unknown;
    }) => { port: number | undefined; stop: (force?: boolean) => void };
  } = {},
): Promise<IWsServeHandle> {
  const mcp = createWssMpcServer();
  mcp.listen((transport: WssServerTransport) =>
    connectPerConnection(transport, handle),
  );

  const serve = deps.serve ?? (Bun.serve as unknown as typeof deps.serve);
  const server = serve({
    hostname: "0.0.0.0",
    port: handle.transport.port,
    fetch: mcp.ws.fetch as unknown,
    websocket: mcp.ws.websocket as unknown,
  }) as unknown as { port?: number; stop: (force?: boolean) => void };

  return {
    port: server.port ?? handle.transport.port,
    close: async () => {
      server.stop();
    },
  };
}
