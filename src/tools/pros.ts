import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { PositiveInt, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { AngiClient } from '../client.js';
import { compactAliasArg, viewArg, wantsCompact } from '../view.js';

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
      inputSchema: z.object({
        profileUrl,
        view: viewArg(),
        compact: compactAliasArg(),
      }),
    },
    async ({ profileUrl: url, view, compact }) =>
      minifiedResult(await client.getPro(url, { compact: wantsCompact({ view, compact }) }))
  );

  server.registerTool(
    'angi_get_reviews',
    {
      description:
        "Read the reviews on an Angi pro's profile page: rating, body text, reported job cost, " +
        'date, service categories, verification flag, and the pro\'s public response where one ' +
        'exists. Filter by rating to isolate complaints or praise.',
      annotations: toolAnnotations({ title: 'Get Angi reviews', idempotent: true, openWorld: true }),
      inputSchema: z.object({
        profileUrl,
        minRating: z.number().min(1).max(5).optional().describe('Keep reviews rated at least this.'),
        maxRating: z
          .number()
          .min(1)
          .max(5)
          .optional()
          .describe('Keep reviews rated at most this — use maxRating: 3 to surface complaints.'),
        limit: PositiveInt.optional().describe('Return at most this many reviews.'),
        view: viewArg(),
        compact: compactAliasArg(),
      }),
    },
    async ({ profileUrl: url, view, compact, ...opts }) =>
      minifiedResult(await client.getReviews(url, { ...opts, compact: wantsCompact({ view, compact }) }))
  );
}
