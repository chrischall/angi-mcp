import { describe, it, expect } from 'vitest';
import { matchBalanced } from '@chrischall/mcp-utils/scrape';
import { objectsWithKey } from '../src/parse.js';

// fleet-audit#1211: objectsWithKey walked back from every hit and
// bracket-matched from every '{' it met, so a hostile page (a long run of
// unclosed braces, a deep chain, thousands of siblings) cost O(hits × size)
// on the single-threaded event loop: 2.7 s at 40k unclosed braces.

/** The pre-#1211 algorithm, kept verbatim as the reference for results. */
function legacyObjectsWithKey(text: string, key: string): Record<string, unknown>[] {
  const needle = `"${key}"`;
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const hit = text.indexOf(needle, from);
    if (hit === -1) break;
    from = hit + needle.length;
    for (let i = hit; i >= 0 && hit - i < 200_000; i--) {
      if (text[i] !== '{') continue;
      const end = matchBalanced(text, i);
      if (end === -1 || end <= hit) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(text.slice(i, end));
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object' || !(key in obj)) continue;
      const id = `${i}:${end - i}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(obj as Record<string, unknown>);
      }
      break;
    }
  }
  return out;
}

const time = (fn: () => unknown): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('objectsWithKey stays linear on hostile flight text', () => {
  it('a long run of unclosed braces before the key (the audit input)', () => {
    const text = '{'.repeat(40_000) + '"legacyId":1,'.repeat(2000);
    expect(time(() => objectsWithKey(text, 'legacyId', { resolve: false }))).toBeLessThan(300);
  });

  it('a deep chain of nested objects, the key only at the bottom as a value', () => {
    const n = 8000;
    const text = '{"a":'.repeat(n) + '"legacyId"' + '}'.repeat(n) + ',"legacyId"'.repeat(2000);
    expect(time(() => objectsWithKey(text, 'legacyId', { resolve: false }))).toBeLessThan(300);
  });

  it('thousands of closed siblings between hits', () => {
    const text = Array.from({ length: 4000 }, () => '{"x":{"y":[1,2,{"z":3}]}}'.repeat(10) + '"legacyId"').join('');
    expect(time(() => objectsWithKey(text, 'legacyId', { resolve: false }))).toBeLessThan(300);
  });

  it('a nested chain whose every level owns the key', () => {
    const n = 4000;
    const text = '{"legacyId":1,"a":'.repeat(n) + '0' + '}'.repeat(n);
    let got: unknown[] = [];
    expect(time(() => (got = objectsWithKey(text, 'legacyId', { resolve: false })))).toBeLessThan(500);
    expect(got.length).toBeGreaterThan(0);
  });
});

describe('objectsWithKey returns what the old walk returned on ordinary text', () => {
  const row = (id: string, v: unknown) => `${id}:${JSON.stringify(v)}`;
  const CASES: string[] = [
    [
      row('1', { legacyId: '1', note: 'has } and ] and { inside', arr: [{ a: '[' }] }),
      row('2', { wrap: { legacyId: '2', q: 'say "hi" }' } }),
      row('3', { list: [{ legacyId: 'a' }, { legacyId: 'b', inner: { legacyId: 'c' } }] }),
      row('4', { label: 'legacyId', other: { x: 1 } }),
      '5:{"legacyId": broken',
      row('6', { deep: { deeper: { deepest: { legacyId: 'd', s: "it's {" } } } }),
      '7:T20,raw "legacyId" text {',
      row('8', { legacyId: 'e', again: { legacyId: 'e' } }),
    ].join('\n'),
    '{"a":{"legacyId":1}}{"b":"legacyId"}{"legacyId":{"legacyId":2}}',
    "{'legacyId':1}{\"legacyId\":\"'\"}",
    '{"x":"}{"legacyId":1}',
    '"legacyId"{"legacyId":0}"legacyId"',
  ];
  // Plus pseudo-random mixes of the same pieces.
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  const PIECES = ['{', '}', '[', ']', '"legacyId"', ':', ',', '1', '"s{"', '{"legacyId":3}', '\n', '"\\""', "'"];
  for (let c = 0; c < 300; c++) {
    let s = '';
    for (let k = 0; k < 40; k++) s += PIECES[rand(PIECES.length)];
    CASES.push(s);
  }

  it.each(CASES.map((c, i) => [i, c]))('case %i', (_i, text) => {
    expect(objectsWithKey(text as string, 'legacyId', { resolve: false })).toEqual(
      legacyObjectsWithKey(text as string, 'legacyId'),
    );
  });
});
