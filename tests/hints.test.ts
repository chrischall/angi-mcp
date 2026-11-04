import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { AngiClient } from '../src/client.js';
import type { AngiTransport } from '../src/transport.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerProTools } from '../src/tools/pros.js';
import { registerTaxonomyTools } from '../src/tools/taxonomy.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * read off `tools/list` — what a host actually sees.
 *
 * angi-mcp answers no what's-new / what's-due / what's-on question: the public
 * tools are directory lookups, and the signed-in project and review records
 * pass through raw (no populated record has ever been observed, so there is no
 * date or status field to brief on). So every tool is a `lookup` and nothing
 * is canonical — the test pins that, so adding a canonical read later has to
 * come with its brief view.
 */
type Listed = {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
  _meta?: { mint?: Record<string, unknown> };
};

const stubTransport: AngiTransport = {
  start: async () => {},
  close: async () => {},
  status: () => ({}),
  fetch: async () => ({ status: 200, body: '' }),
  runProbe: async () => ({}),
};

async function served(): Promise<Listed[]> {
  const client = new AngiClient({ transport: stubTransport });
  const h = await createTestHarness((server) => {
    registerSearchTools(server, client);
    registerProTools(server, client);
    registerTaxonomyTools(server, client);
    registerAccountTools(server, client);
    registerHealthcheckTools(server, client, stubTransport as never);
  });
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as Listed[];
}

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

/** The intent every served tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  angi_search_pros: 'lookup',
  angi_get_pro: 'lookup',
  angi_get_reviews: 'lookup',
  angi_list_trades: 'lookup',
  angi_list_cities: 'lookup',
  angi_get_account: 'lookup',
  angi_list_my_projects: 'lookup',
  angi_list_my_reviews: 'lookup',
};

describe('_meta.mint hints on the served tool list', () => {
  it('names every served tool but the healthcheck, so a new tool cannot skip the decision', async () => {
    const names = (await served()).map((t) => t.name).filter((n) => !n.endsWith('_healthcheck'));
    expect(names.sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain home and intent %s', async (name, intent) => {
    const mint = (await served()).find((t) => t.name === name)?._meta?.mint;
    expect(mint, name).toBeDefined();
    expect(mint!.domain).toBe('home');
    expect(mint!.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of await served()) {
      if (t.name.endsWith('_healthcheck')) continue; // registered by mcp-utils, which takes no _meta
      const m = t._meta!.mint!;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(m).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(m.domain);
      expect(INTENTS, t.name).toContain(m.intent);
      if ('canonical' in m) {
        expect(m.canonical, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(CANONICAL_INTENTS, t.name).toContain(m.intent);
        expect(props, t.name).toHaveProperty('view');
      }
      if ('subject' in m) expect(props, t.name).toHaveProperty(m.subject as string);
      if ('when' in m) {
        const when = m.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start);
        expect(props, t.name).toHaveProperty(when.end);
      }
      if ('aliases' in m) {
        const aliases = m.aliases as string[];
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('at most one canonical read per what’s-new / what’s-due / what’s-on — and angi answers none', async () => {
    const canonical = (await served()).filter((t) => t._meta?.mint?.canonical === true);
    for (const intent of CANONICAL_INTENTS) {
      expect(canonical.filter((t) => t._meta!.mint!.intent === intent).length, intent).toBeLessThanOrEqual(1);
    }
    expect(canonical.map((t) => t.name)).toEqual([]);
  });

  it('declares no subject: angi has no listable set of the person’s subjects', async () => {
    const withSubject = (await served()).filter((t) => t._meta?.mint && 'subject' in t._meta.mint);
    expect(withSubject.map((t) => t.name)).toEqual([]);
  });

  it('gives the pro search the words a person says', async () => {
    const search = (await served()).find((t) => t.name === 'angi_search_pros')!;
    expect(search._meta!.mint!.aliases).toEqual(
      expect.arrayContaining(['contractor', 'plumber', 'electrician', 'handyman']),
    );
  });
});
