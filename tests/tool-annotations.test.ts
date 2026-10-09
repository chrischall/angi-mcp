import { describe, it, expect } from 'vitest';
import { AngiClient } from '../src/client.js';
import type { AngiTransport } from '../src/transport.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerProTools } from '../src/tools/pros.js';
import { registerTaxonomyTools } from '../src/tools/taxonomy.js';
import { registerAccountTools } from '../src/tools/account.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

/**
 * Fleet annotation meta-test. `destructiveHint` DEFAULTS TO TRUE whenever
 * `readOnlyHint` is false, so a new write that forgets to declare it publishes
 * as destructive and nothing fails — a considered `false` and a forgotten one
 * leave identical annotations. This reads the REGISTERED config, not a
 * hand-kept list, so a new tool cannot skip the decision.
 */
interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

const stubTransport: AngiTransport = {
  start: async () => {},
  close: async () => {},
  status: () => ({}),
  fetch: async () => ({ status: 200, body: '' }),
  runProbe: async () => ({}),
};

function registeredAnnotations(): Record<string, Ann | undefined> {
  const seen: Record<string, Ann | undefined> = {};
  const server = {
    registerTool: (name: string, cfg: { annotations?: Ann }) => {
      seen[name] = cfg.annotations;
    },
  } as never;
  const client = new AngiClient({ transport: stubTransport });
  registerSearchTools(server, client);
  registerProTools(server, client);
  registerTaxonomyTools(server, client);
  registerAccountTools(server, client);
  registerHealthcheckTools(server, client, stubTransport as never);
  return seen;
}

describe('every tool is annotated truthfully', () => {
  it('registers the full surface (guards against a registrar being dropped here)', () => {
    expect(Object.keys(registeredAnnotations())).toHaveLength(9);
  });

  it('sets an explicit boolean readOnlyHint on all of them', () => {
    const missing = Object.entries(registeredAnnotations())
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    const contradictory = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(contradictory).toEqual([]);
  });

  it('marks every tool open-world — each one reaches angi.com through the bridge', () => {
    const closed = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.openWorldHint !== true)
      .map(([name]) => name);
    expect(closed).toEqual([]);
  });

  it('is read-only end to end (angi-mcp has no write tools)', () => {
    const writes = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint !== true)
      .map(([name]) => name);
    expect(writes).toEqual([]);
  });
});
