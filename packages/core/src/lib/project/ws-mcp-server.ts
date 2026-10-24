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
 * Launch the http→wss MCP endpoint. Every WebSocket upgrade on `/mcp` gets a
 * fresh McpServer bound to that socket's transport, with the tool/prompt/
 * resource registrations replayed on it.
 */
export async function serveWss(handle: {
  readonly transport: IWssTransportConfig;
  readonly ordered: readonly IToolRegistration[];
  readonly prompts: readonly IPromptRegistration[];
  readonly resources: readonly IResourceRegistration[];
}): Promise<IWsServeHandle> {
  const mcp = createWssMpcServer();

  mcp.listen((transport: WssServerTransport) => {
    const conn = new McpServer({
      name: handle.transport.serverName,
      title: handle.transport.title ?? "DelendAI",
      version: handle.transport.serverVersion,
    });
    // Replay the materialized registrations onto this connection's server.
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
        transport.onerror?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    })();
  });

  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: handle.transport.port,
    fetch: mcp.ws.fetch as never,
    websocket: mcp.ws.websocket as never,
  });

  return {
    port: server.port ?? handle.transport.port,
    close: async () => {
      server.stop();
    },
  };
}
