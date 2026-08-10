// Adapter letting @fetchproxy/server satisfy AngiTransport.
//
// Angi fronts www.angi.com with Cloudflare: every content page returns 403 to a
// plain server-side fetch, and the cf_clearance cookie is bound to IP + User-
// Agent + TLS fingerprint together, so lifting it out of the browser does not
// help. Requests therefore run inside the user's own signed-in tab, which has
// already cleared the challenge. Only the sitemaps are reachable server-side —
// the client fetches those with plain node fetch and never touches the bridge
// for them.
//
// The verb surface (fetch / runProbe / status / start / close) comes from the
// shared `createFetchproxyTransport` in @chrischall/mcp-utils/fetchproxy.

import {
  createFetchproxyTransport,
  type FetchproxyTransport as FetchproxyVerbTransport,
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyProtocolError,
  classifyBridgeError,
  type BridgeError,
} from '@chrischall/mcp-utils/fetchproxy';
import type { AngiTransport, FetchInit, FetchResult } from './transport.js';

export {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyProtocolError,
  classifyBridgeError,
};
export type { BridgeError };

/**
 * The whole fetchproxy fleet shares this concentrator port — the Transporter
 * extension dials this one port and servers host/peer-elect on it. Picking a
 * "unique" port means the extension never connects.
 */
export const DEFAULT_PORT = 37_149;

const DEBUG = process.env.ANGI_DEBUG === '1';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[angi-mcp:bridge]', ...args);
}

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. */
  server?: string;
  version: string;
  fetchTimeoutMs?: number;
}

export class FetchproxyTransport implements AngiTransport {
  private readonly inner: FetchproxyVerbTransport;
  private readonly port: number;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.inner = createFetchproxyTransport<FetchproxyVerbTransport>({
      port: this.port,
      serverName: opts.server ?? 'angi-mcp',
      version: opts.version,
      logListening: true,
      // Subdomains of angi.com match automatically.
      domains: ['angi.com'],
      defaultSubdomain: 'www',
      ...(opts.fetchTimeoutMs !== undefined
        ? { fetchTimeoutMs: opts.fetchTimeoutMs }
        : {}),
    });
  }

  async start(): Promise<void> {
    log('listen start', { port: this.port });
    await this.inner.start();
  }

  async close(): Promise<void> {
    log('close');
    return this.inner.close();
  }

  // Return the inner (precise) type rather than the loose seam type: the
  // shared registerBridgeHealthcheckTool needs the full BridgeHealth shape,
  // and a narrower return type still satisfies AngiTransport.
  status(): ReturnType<FetchproxyVerbTransport['status']> {
    return this.inner.status();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const start = Date.now();
    log('fetch:start', { method: init.method, path: init.path });
    const response = await this.inner.fetch({
      method: init.method,
      path: init.path,
      headers: init.headers,
      body: init.body,
      ...(init.subdomain !== undefined ? { subdomain: init.subdomain } : {}),
    });
    log('fetch:done', {
      path: init.path,
      elapsed: Date.now() - start,
      status: response.status,
      bodyLen: response.body.length,
    });
    return { status: response.status, body: response.body, url: response.url };
  }

  async runProbe(
    fetchFn: (path: string) => Promise<string>,
    probePath: string
  ): ReturnType<FetchproxyVerbTransport['runProbe']> {
    return this.inner.runProbe(fetchFn, probePath);
  }
}
