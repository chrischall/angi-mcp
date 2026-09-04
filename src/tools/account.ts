import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { guard } from './_shared.js';
import type { AngiClient } from '../client.js';

/**
 * Signed-in account tools (my.angi.com).
 *
 * These read the account app rather than the public site, so they need the
 * browser tab to be signed in to Angi. Project and review RECORDS pass through
 * raw: the account used to capture these surfaces held zero projects and zero
 * reviews, so no per-record field has ever been observed and inventing a
 * projection would be a guess. Each response carries
 * `recordFieldsVerified: false` to say so out loud.
 */
export function registerAccountTools(server: McpServer, client: AngiClient): void {
  server.registerTool(
    'angi_get_account',
    {
      description:
        'The signed-in Angi user: first name, user/entity ids, unread message count, and how ' +
        'many open and closed projects they have. Requires the browser tab to be signed in.',
      annotations: toolAnnotations({ title: 'Get Angi account', idempotent: true, openWorld: true }),
      inputSchema: {},
    },
    async () => guard('angi_get_account', async () => minifiedResult(await client.getAccount()))
  );

  server.registerTool(
    'angi_list_my_projects',
    {
      description:
        "The signed-in user's Angi projects (service requests and bookings), open and closed. " +
        'Records are returned exactly as Angi sends them — the response sets ' +
        '`recordFieldsVerified: false` because no populated project has been observed yet, so ' +
        'field names should be read from the data rather than assumed.',
      annotations: toolAnnotations({
        title: 'List my Angi projects',
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {
        status: z
          .enum(['open', 'closed', 'all'])
          .optional()
          .describe('Which project list to return. Defaults to all.'),
      },
    },
    async ({ status }) =>
      guard('angi_list_my_projects', async () =>
        minifiedResult(await client.listMyProjects({ status }))
      )
  );

  server.registerTool(
    'angi_list_my_reviews',
    {
      description:
        'Reviews the signed-in user has written, plus pros Angi is prompting them to rate ' +
        '(`unratedPros`). Same caveat as projects: records pass through raw and the response ' +
        'sets `recordFieldsVerified: false`.',
      annotations: toolAnnotations({
        title: 'List my Angi reviews',
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: {},
    },
    async () => guard('angi_list_my_reviews', async () => minifiedResult(await client.listMyReviews()))
  );
}
