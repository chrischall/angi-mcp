#!/usr/bin/env node
// angi-mcp entrypoint.
//
// Boot sequence:
//   1. Construct a FetchproxyTransport on 127.0.0.1:37149 — the port the whole
//      fetchproxy fleet shares, which the Transporter browser extension dials.
//   2. AngiClient.start() brings the bridge up BEFORE runMcp connects stdio, so
//      a bridge that cannot come up surfaces here rather than wedging the
//      JSON-RPC channel on the host's first tool call.
//   3. runMcp registers the tools, prints the stderr banner, wires
//      SIGINT/SIGTERM to close the transport, and connects stdio.
//
// Angi needs no credentials: every tool here reads public pages. The bridge is
// required not for authentication but for reachability — Cloudflare 403s any
// server-side request to www.angi.com, so requests run inside the user's tab.

import { runMcp, readPortEnv } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { AngiClient } from './client.js';
import { FetchproxyTransport, DEFAULT_PORT } from './transport-fetchproxy.js';
import { registerSearchTools } from './tools/search.js';
import { registerProTools } from './tools/pros.js';
import { registerTaxonomyTools } from './tools/taxonomy.js';
import { registerAccountTools } from './tools/account.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';

const port = readPortEnv('ANGI_WS_PORT', DEFAULT_PORT);

const transport = new FetchproxyTransport({ port, version: VERSION });
const client = new AngiClient({ transport });
await client.start();

await runMcp({
  name: 'angi-mcp',
  version: VERSION,
  deps: client,
  tools: [
    (server) => registerSearchTools(server, client),
    (server) => registerProTools(server, client),
    (server) => registerTaxonomyTools(server, client),
    (server) => registerAccountTools(server, client),
    (server) => registerHealthcheckTools(server, client, transport),
  ],
  banner:
    `[angi-mcp] v${VERSION} — reads angi.com through the user's signed-in browser tab via the ` +
    `fetchproxy bridge on 127.0.0.1:${port}. Install the fetchproxy extension ` +
    '(see https://github.com/chrischall/fetchproxy) and keep an angi.com tab open. ' +
    'This project was developed and is maintained by AI (Claude). Use at your own discretion.',
  shutdown: { onSignal: () => client.close() },
});
