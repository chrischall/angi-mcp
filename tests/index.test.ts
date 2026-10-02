import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AngiClient } from '../src/client.js';
import type { AngiTransport } from '../src/transport.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerProTools } from '../src/tools/pros.js';
import { registerTaxonomyTools } from '../src/tools/taxonomy.js';
import { registerAccountTools } from '../src/tools/account.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const stubTransport: AngiTransport = {
  start: async () => {},
  close: async () => {},
  status: () => ({}),
  fetch: async () => ({ status: 200, body: '' }),
  runProbe: async () => ({}),
};

/** The tool roster, minus angi_healthcheck (which needs the concrete transport). */
function registeredToolNames(): string[] {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
    },
  } as unknown as Parameters<typeof registerSearchTools>[0];
  const client = new AngiClient({ transport: stubTransport });
  registerSearchTools(server, client);
  registerProTools(server, client);
  registerTaxonomyTools(server, client);
  registerAccountTools(server, client);
  return names;
}

describe('tool roster', () => {
  it('registers the expected tools', () => {
    expect(registeredToolNames().sort()).toEqual([
      'angi_get_account',
      'angi_get_pro',
      'angi_get_reviews',
      'angi_list_cities',
      'angi_list_my_projects',
      'angi_list_my_reviews',
      'angi_list_trades',
      'angi_search_pros',
    ]);
  });

  it('publishes search inputs through the SDK v2 tools/list schema', async () => {
    const client = new AngiClient({ transport: stubTransport });
    const harness = await createTestHarness((server) => registerSearchTools(server, client));
    const { tools } = await harness.client.listTools();
    const tool = tools.find((candidate) => candidate.name === 'angi_search_pros');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        trade: { type: 'string' },
        state: { type: 'string' },
        city: { type: 'string' },
      },
      required: ['trade', 'state', 'city'],
    });
    await harness.close();
  });

  it('namespaces every tool under angi_', () => {
    for (const name of registeredToolNames()) {
      expect(name).toMatch(/^angi_/);
    }
  });

  it('declares each tool in manifest.json', () => {
    const declared = new Set(
      (JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).tools as {
        name: string;
      }[]).map((t) => t.name)
    );
    // The .mcpb manifest is what a host shows before install, so a tool missing
    // from it is invisible to users even though the server serves it.
    for (const name of [...registeredToolNames(), 'angi_healthcheck']) {
      expect(declared, `${name} missing from manifest.json`).toContain(name);
    }
  });
});

/**
 * Error rendering comes from runMcp / createTestHarness (fleet-audit#980): a
 * thrown McpToolError's hint is appended to the failing tool's text, and
 * anything else still surfaces as an error result rather than being swallowed
 * by a per-tool wrapper.
 */
describe('tool error rendering', () => {
  function failing(fetch: AngiTransport['fetch']): AngiClient {
    return new AngiClient({ transport: { ...stubTransport, fetch } });
  }
  function textOf(result: { content?: unknown }): string {
    return ((result.content ?? []) as { type: string; text?: string }[])
      .map((c) => c.text ?? '')
      .join('');
  }

  it("appends a thrown McpToolError's hint to the tool's text", async () => {
    const client = failing(async () => ({ status: 200, body: '<html>nothing</html>' }));
    const harness = await createTestHarness((server) => registerAccountTools(server, client));
    const result = await harness.client.callTool({ name: 'angi_get_account', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No __NEXT_DATA__ payload/);
    expect(textOf(result)).toMatch(/Hint: Confirm the browser tab is signed in/);
    await harness.close();
  });

  it('still reports an unexpected throw as an error result', async () => {
    const client = failing(async () => {
      throw new Error('bridge exploded');
    });
    const harness = await createTestHarness((server) => registerSearchTools(server, client));
    const result = await harness.client.callTool({
      name: 'angi_search_pros',
      arguments: { trade: 'plumbing', state: 'nc', city: 'charlotte' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/bridge exploded/);
    await harness.close();
  });
});
