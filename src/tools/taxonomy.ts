import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import { guard } from './_shared.js';
import type { AngiClient } from '../client.js';

export function registerTaxonomyTools(server: McpServer, client: AngiClient): void {
  server.registerTool(
    'angi_list_trades',
    {
      description:
        'List every trade slug Angi publishes (~312, e.g. "plumbing", "air-duct-cleaning", ' +
        '"basement-waterproofing"). Call this to resolve a free-text trade to the slug ' +
        'angi_search_pros needs. Reads Angi\'s public sitemap directly — no browser bridge required.',
      annotations: toolAnnotations({ title: 'List Angi trades', idempotent: true, openWorld: true }),
      inputSchema: {
        contains: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter, e.g. "duct" or "roof".'),
      },
    },
    async ({ contains }) =>
      guard('angi_list_trades', async () => {
        let trades = await client.listTrades();
        if (contains) {
          const needle = contains.toLowerCase();
          trades = trades.filter((t) => t.includes(needle));
        }
        return textResult({ count: trades.length, trades });
      })
  );

  server.registerTool(
    'angi_list_cities',
    {
      description:
        'List every US state/city that Angi publishes pages for, for one trade. Use it to ' +
        'confirm a city slug exists before searching, or to discover nearby cities. ' +
        'Reads Angi\'s public sitemap directly — no browser bridge required.',
      annotations: toolAnnotations({ title: 'List Angi cities', idempotent: true, openWorld: true }),
      inputSchema: {
        trade: z.string().describe('Trade slug, e.g. "plumbing".'),
        state: z
          .string()
          .optional()
          .describe('Restrict to one two-letter state code, e.g. "nc".'),
        contains: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter on the city slug.'),
      },
    },
    async ({ trade, state, contains }) =>
      guard('angi_list_cities', async () => {
        let cities = await client.listCities(trade, { state });
        if (contains) {
          const needle = contains.toLowerCase();
          cities = cities.filter((c) => c.city.includes(needle));
        }
        return textResult({ trade, count: cities.length, cities });
      })
  );
}
