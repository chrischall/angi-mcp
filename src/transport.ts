// Transport seam. The MCP talks to angi.com through this interface so tests can
// inject a stub instead of standing up a real browser bridge.
//
// `status()` and `runProbe()` are typed loosely on purpose: their concrete
// shapes belong to @fetchproxy/server (BridgeHealth / BridgeProbeResult) and
// re-declaring them here only creates two definitions that drift apart. The
// real transport returns the precise types — which are assignable to these —
// and the shared healthcheck registrar consumes the concrete class directly.

/** HTTP methods the bridge accepts. */
export type BridgeMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface FetchInit {
  method: BridgeMethod;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Per-call subdomain override. Content pages live on `www`, the signed-in
   * account app on `my` — both under the same declared apex.
   */
  subdomain?: string;
}

export interface FetchResult {
  status: number;
  body: string;
  url?: string;
}

export interface AngiTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  /** @fetchproxy/server's BridgeHealth. */
  status(): unknown;
  fetch(init: FetchInit): Promise<FetchResult>;
  /** @fetchproxy/server's BridgeProbeResult. */
  runProbe(
    fetchFn: (path: string) => Promise<string>,
    probePath: string
  ): Promise<unknown>;
}
