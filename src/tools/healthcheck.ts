import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBridgeHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
import type { AngiClient } from '../client.js';
import type { FetchproxyTransport } from '../transport-fetchproxy.js';

export function registerHealthcheckTools(
  server: McpServer,
  client: AngiClient,
  transport: FetchproxyTransport
): void {
  registerBridgeHealthcheckTool({
    server,
    prefix: 'angi',
    // robots.txt is the one angi.com path that is cheap, stable and not
    // Cloudflare-gated, so a failure here really does mean the bridge.
    probePath: '/robots.txt',
    hostLabel: 'www.angi.com',
    transport,
    // Probe through the same client path the real tools use, so a sign-in or
    // challenge guard shows up here rather than only under a tool call.
    probeFn: (path) => client.fetchHtml(path),
  });
}
