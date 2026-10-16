import { z } from 'zod';
import { resolveView, viewParam, type View } from '@chrischall/mcp-utils';

/**
 * The rungs angi's record tools honour (`@chrischall/mcp-utils`' `view`
 * vocabulary; `chrischall/workflows` `docs/fleet-conventions.md`, "Response
 * shape"). fleet-audit#1212.
 *
 * These tools used to take an opt-in `compact` boolean, so they returned
 * Angi's full RSC records (hundreds of fields) unless the model remembered to
 * ask for less. `compact` — the hand-written compactProvider / compactReview
 * projection — is the default now; `full` returns the whole records. No `raw`
 * rung: `full` already is the untouched upstream payload.
 *
 * The old `compact` boolean is kept as a deprecated alias for one release: it
 * applies only when `view` is absent.
 */
export const ANGI_VIEWS = ['compact', 'full'] as const;

const NOTE =
  'compact returns a slim projection of each record (falling back to the full record if the projection ' +
  'does not fit the payload); "full" returns Angi\'s whole records.';

/** The `view` parameter the record tools take. */
export const viewArg = (): ReturnType<typeof viewParam> => viewParam(ANGI_VIEWS, { note: NOTE });

/** The deprecated `compact` boolean, kept for one release. */
export const compactAliasArg = () =>
  z
    .boolean()
    .optional()
    .describe('Deprecated: use `view` instead (compact: true = view "compact", false = view "full"). Ignored when `view` is set.');

/** Should this call get the compact projection? `view` wins; else the alias; else compact. */
export function wantsCompact({ view, compact }: { view?: string; compact?: boolean }): boolean {
  if (view === undefined && compact !== undefined) return compact;
  const rung: View = resolveView(view, ANGI_VIEWS);
  return rung === 'compact';
}
