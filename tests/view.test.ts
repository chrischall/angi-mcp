import { describe, it, expect, vi } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { AngiClient } from '../src/client.js';
import type { AngiTransport } from '../src/transport.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerProTools } from '../src/tools/pros.js';

// fleet-audit#1212: the record tools take the fleet `view` rung (compact by
// default, `full` for Angi's whole records) instead of an opt-in `compact`
// boolean. `compact` stays as a deprecated alias for one release.

const stubTransport: AngiTransport = {
  start: async () => {},
  close: async () => {},
  status: () => ({}),
  fetch: async () => ({ status: 200, body: '' }),
  runProbe: async () => ({}),
};

async function harnessWithSpies() {
  const client = new AngiClient({ transport: stubTransport });
  const search = vi.spyOn(client, 'searchPros').mockResolvedValue({} as never);
  const getPro = vi.spyOn(client, 'getPro').mockResolvedValue({} as never);
  const getReviews = vi.spyOn(client, 'getReviews').mockResolvedValue({} as never);
  const harness = await createTestHarness((server) => {
    registerSearchTools(server, client);
    registerProTools(server, client);
  });
  return { harness, search, getPro, getReviews };
}

const SEARCH = { trade: 'plumbing', state: 'nc', city: 'charlotte' };
const URL = '/companylist/us/nc/charlotte/x-reviews-1.htm';

describe('view rung on the record tools', () => {
  it.each([
    ['default (no view, no compact)', {}, true],
    ['view: compact', { view: 'compact' }, true],
    ['view: full', { view: 'full' }, false],
    ['deprecated compact: false', { compact: false }, false],
    ['deprecated compact: true', { compact: true }, true],
    ['view wins over the deprecated alias', { view: 'full', compact: true }, false],
  ])('%s', async (_label, extra, compact) => {
    const { harness, search, getPro, getReviews } = await harnessWithSpies();
    try {
      await harness.client.callTool({ name: 'angi_search_pros', arguments: { ...SEARCH, ...extra } });
      expect(search.mock.calls[0][0]).toMatchObject({ ...SEARCH, compact });
      expect(search.mock.calls[0][0]).not.toHaveProperty('view');

      await harness.client.callTool({ name: 'angi_get_pro', arguments: { profileUrl: URL, ...extra } });
      expect(getPro.mock.calls[0]).toEqual([URL, { compact }]);

      await harness.client.callTool({ name: 'angi_get_reviews', arguments: { profileUrl: URL, maxRating: 3, ...extra } });
      expect(getReviews.mock.calls[0]).toEqual([URL, { maxRating: 3, compact }]);
    } finally {
      await harness.close();
    }
  });

  it('advertises view as compact|full and marks compact deprecated', async () => {
    const { harness } = await harnessWithSpies();
    try {
      const { tools } = await harness.client.listTools();
      for (const name of ['angi_search_pros', 'angi_get_pro', 'angi_get_reviews']) {
        const props = (tools.find((t) => t.name === name)?.inputSchema as { properties: Record<string, { enum?: string[]; description?: string }> }).properties;
        expect(props.view?.enum, name).toEqual(['compact', 'full']);
        expect(props.compact?.description, name).toMatch(/deprecated/i);
      }
    } finally {
      await harness.close();
    }
  });

  it('rejects an unknown view', async () => {
    const { harness } = await harnessWithSpies();
    try {
      const res = await harness.client.callTool({ name: 'angi_search_pros', arguments: { ...SEARCH, view: 'raw' } });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
