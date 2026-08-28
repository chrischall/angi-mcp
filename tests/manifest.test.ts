import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>;

describe('manifest.json is packable by mcpb', () => {
  // The mcpb manifest schema sets `additionalProperties: false`, so ONE stray
  // top-level key makes `mcpb pack` fail outright — and that failure is close
  // to invisible in CI, because the publish step still reports success and
  // still prints "Built <name>.mcpb". This repo shipped v0.1.0 with no .mcpb
  // attached for exactly that reason (a top-level `runtimes`). Key list taken
  // from mcpb 2.1.2's own dist/mcpb-manifest-v0.2.schema.json.
  const ALLOWED = new Set([
    '$schema', 'dxt_version', 'manifest_version', 'name', 'display_name', 'version',
    'description', 'long_description', 'author', 'repository', 'homepage', 'documentation',
    'support', 'icon', 'screenshots', 'server', 'tools', 'tools_generated', 'prompts',
    'prompts_generated', 'keywords', 'license', 'privacy_policies', 'compatibility', 'user_config',
  ]);

  it('has no top-level key the schema would reject', () => {
    expect(Object.keys(manifest).filter((k) => !ALLOWED.has(k))).toEqual([]);
  });

  it('declares its node floor under compatibility, not at the top level', () => {
    expect(manifest).not.toHaveProperty('runtimes');
    const compat = manifest.compatibility as { runtimes?: { node?: string } } | undefined;
    expect(compat?.runtimes?.node).toMatch(/^>=/);
  });

  it('keeps the node floor on an LTS so LTS users can install', () => {
    const node = (manifest.compatibility as { runtimes: { node: string } }).runtimes.node;
    expect(Number(node.replace(/^\D*/, '').split('.')[0])).toBeLessThanOrEqual(22);
  });
});
