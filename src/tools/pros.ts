import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PositiveInt, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { guard } from './_shared.js';
import type { AngiClient } from '../client.js';

const profileUrl = z
  .string()
  .describe(
    'The pro\'s Angi profile URL or site-relative path, as returned in `profileUrl` by angi_search_pros ' +
      '(e.g. "/companylist/us/nc/charlotte/mkb-plumbing-and-septic-llc-reviews-8535260.htm").'
  );

export function registerProTools(server: McpServer, client: AngiClient): void {
  server.registerTool(
    'angi_get_pro',
    {
      description:
        "Read one Angi pro's full profile: business details, service area, hours, amenities, " +
        'awards, tasks offered, contact address, and the ratings breakdown. Also reports how ' +
        'many reviews the page carries (fetch them with angi_get_reviews).',
      annotations: toolAnnotations({ title: 'Get Angi pro', idempotent: true, openWorld: true }),
      inputSchema: {
        profileUrl,
        compact: z
          .boolean()
          .optional()
          .describe('Return a slim summary instead of the full record.'),
      },
    },
    async ({ profileUrl: url, compact }) =>
      guard('angi_get_pro', async () => minifiedResult(await client.getPro(url, { compact })))
  );

  server.registerTool(
    'angi_get_reviews',
    {
      description:
        "Read the reviews on an Angi pro's profile page: rating, body text, reported job cost, " +
        'date, service categories, verification flag, and the pro\'s public response where one ' +
        'exists. Filter by rating to isolate complaints or praise.',
      annotations: toolAnnotations({ title: 'Get Angi reviews', idempotent: true, openWorld: true }),
      inputSchema: {
        profileUrl,
        minRating: z.number().min(1).max(5).optional().describe('Keep reviews rated at least this.'),
        maxRating: z
          .number()
          .min(1)
          .max(5)
          .optional()
          .describe('Keep reviews rated at most this — use maxRating: 3 to surface complaints.'),
        limit: PositiveInt.optional().describe('Return at most this many reviews.'),
        compact: z
          .boolean()
          .optional()
          .describe('Return a slim summary per review instead of the full record.'),
      },
    },
    async ({ profileUrl: url, ...opts }) =>
      guard('angi_get_reviews', async () => minifiedResult(await client.getReviews(url, opts)))
  );
}
