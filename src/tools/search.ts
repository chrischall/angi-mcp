import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, PositiveInt } from '@chrischall/mcp-utils';
import { guard } from './_shared.js';
import type { AngiClient } from '../client.js';

export function registerSearchTools(server: McpServer, client: AngiClient): void {
  server.registerTool(
    'angi_search_pros',
    {
      description:
        'Find home-service pros on Angi for a trade in a US city. Returns each pro with ' +
        'ratings (overall plus per-dimension: quality, value, punctuality, professionalism, ' +
        'responsiveness), review count, percent-recommended, years in business, service area ' +
        'and amenities. `trade` and `city` are Angi slugs — resolve them with angi_list_trades ' +
        'and angi_list_cities first. 10 pros per page; use `page` to walk further. ' +
        'Note Angi has no zip-code filter: location comes from the city slug only.',
      annotations: toolAnnotations({ title: 'Search Angi pros', idempotent: true, openWorld: true }),
      inputSchema: {
        trade: z
          .string()
          .describe('Trade slug, e.g. "plumbing", "roofing", "air-duct-cleaning".'),
        state: z.string().describe('Two-letter US state code, e.g. "nc".'),
        city: z.string().describe('City slug, e.g. "charlotte", "rock-hill".'),
        page: PositiveInt.optional().describe('1-based page number. 10 pros per page.'),
        compact: z
          .boolean()
          .optional()
          .describe(
            'Return a slim summary per pro instead of the full record. Recommended when browsing or ranking.'
          ),
      },
    },
    async (args) =>
      guard('angi_search_pros', async () => textResult(await client.searchPros(args)))
  );
}
