import { describe, it, expect } from 'vitest';
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
