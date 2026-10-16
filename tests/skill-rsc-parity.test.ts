import { describe, it, expect } from 'vitest';
import * as server from '../src/parse.js';
// The fpx skill ships a dependency-free copy of the flight parser so it can run
// as `node rsc.mjs` with no install. Two copies drift (fleet-audit#349): a fix
// landed in one leaves the other returning `"$58"` tokens as review text. This
// suite runs both on the same pages so any divergence fails CI.
// @ts-expect-error -- plain .mjs with no type declarations
import * as skill from '../skills/angi-fpx/references/rsc.mjs';

function makePage(rows: string[], chunks = 3): string {
  const lit = JSON.stringify(rows.join('\n')).slice(1, -1);
  const size = Math.ceil(lit.length / chunks);
  let html = '<html>';
  for (let i = 0; i < lit.length; i += size) {
    html += `<script>self.__next_f.push([1,"${lit.slice(i, i + size)}"])</script>`;
  }
  return `${html}</html>`;
}
const row = (id: string, value: unknown) => `${id}:${JSON.stringify(value)}`;
/** A raw RSC text chunk: `<id>:T<hex byte length>,<text>`. */
const textRow = (id: string, text: string) =>
  `${id}:T${new TextEncoder().encode(text).length.toString(16)},${text}`;

const FIXTURES: Record<string, { html: string; keys: string[] }> = {
  'search page with duplicate provider and chained refs': {
    html: makePage([
      '1:HL["https://cdn.example/app.css","style"]',
      '2:I["4512",["static/chunk.js"],"Default"]',
      row('3', { id: 'u1', legacyId: '1', businessInfo: '$eb', rating: '$fb', tags: '$b5' }),
      row('eb', { businessName: 'Superior {Plumbing} [and] "Drains"', serviceArea: '$$literal' }),
      row('fb', { reviewCount: 34, averageRatings: { OVERALL: 4.65625 } }),
      row('b5', ['$b6']),
      row('b6', ['a', 'b']),
      row('4', { id: 'u1', legacyId: '1', businessInfo: '$eb', gone: '$undefined' }),
    ]),
    keys: ['legacyId', 'businessName', 'reviewCount', 'absent'],
  },
  'profile page with text-chunk review bodies': {
    html: makePage([
      row('7', { reviewId: 'r1', rating: 5, text: '$a1', categories: '$b5' }),
      textRow('a1', 'Café work — great.\nWould hire again ✓'),
      row('8', { reviewId: 'r2', rating: 2, text: '$58' }),
      row('b5', [{ haId: 1, name: 'Septic' }]),
      row('9', { reviewId: 'r3', starRating: 4, nested: { reviewId: 'inner' } }),
    ]),
    keys: ['reviewId', 'haId'],
  },
  'reference cycle and malformed rows': {
    html:
      makePage([
        row('3', { legacyId: 'c', self: '$3', loop: '$a' }),
        row('a', { back: '$b' }),
        row('b', { back: '$a' }),
        '5:{"legacyId": broken',
      ]) + '<script>self.__next_f.push([1,"\\uZZZZ"])</script>',
    keys: ['legacyId', 'back'],
  },
};

describe('skill rsc.mjs stays in lockstep with src/parse.ts', () => {
  for (const [name, { html, keys }] of Object.entries(FIXTURES)) {
    describe(name, () => {
      const text = server.flightText(html);

      it('flightText', () => {
        expect(skill.flightText(html)).toBe(text);
      });

      it('flightRows', () => {
        expect(skill.flightRows(text)).toEqual(server.flightRows(text));
      });

      for (const key of keys) {
        it(`recordsFromHtml(${key}) resolved, raw and limited`, () => {
          expect(skill.recordsFromHtml(html, key)).toEqual(server.recordsFromHtml(html, key));
          expect(skill.recordsFromHtml(html, key, { resolveRefs: false })).toEqual(
            server.recordsFromHtml(html, key, { resolve: false })
          );
          expect(skill.recordsFromHtml(html, key, { limit: 1 })).toEqual(
            server.recordsFromHtml(html, key, { limit: 1 })
          );
        });
      }
    });
  }

  it('resolve matches resolveRefs on edge tokens', () => {
    const rows = new Map<string, unknown>([
      ['a', ['$b']],
      ['b', { x: '$a', y: '$undefined', z: '$$keep' }],
    ]);
    for (const v of ['$a', '$zz', '$$x', '$undefined', 'plain', 42, null, { k: '$a' }]) {
      expect(skill.resolve(v, rows)).toEqual(server.resolveRefs(v, rows));
    }
  });

  it('objectsWithKey agrees on brackets inside strings', () => {
    const text = [
      row('3', { legacyId: '1', note: 'has } and ] and { inside', arr: [{ a: '[' }] }),
      row('4', { wrap: { legacyId: '2', q: 'say \\"hi\\" }' } }),
    ].join('\n');
    expect(skill.objectsWithKey(text, 'legacyId')).toEqual(
      server.objectsWithKey(text, 'legacyId')
    );
  });

  it('objectsWithKey agrees on hostile and random flight text (fleet-audit#1211)', () => {
    const texts = [
      '{'.repeat(20_000) + '"legacyId":1,'.repeat(500),
      '{"a":'.repeat(3000) + '"legacyId"' + '}'.repeat(3000) + ',"legacyId"'.repeat(500),
      '{"legacyId":1,"a":'.repeat(2000) + '0' + '}'.repeat(2000),
      "{'legacyId':1}{\"legacyId\":\"'\"}{\"x\":\"}{\"legacyId\":2}",
    ];
    let seed = 11;
    const rand = (n: number) => ((seed = (seed * 48271) % 2147483647), seed % n);
    const PIECES = ['{', '}', '[', ']', '"legacyId"', ':', ',', '1', '"s{"', '{"legacyId":3}', '\n', "'"];
    for (let c = 0; c < 200; c++) {
      let t = '';
      for (let k = 0; k < 40; k++) t += PIECES[rand(PIECES.length)];
      texts.push(t);
    }
    for (const text of texts) {
      expect(skill.objectsWithKey(text, 'legacyId', { resolveRefs: false })).toEqual(
        server.objectsWithKey(text, 'legacyId', { resolve: false })
      );
    }
  });

  it('the inlined matchBalanced is the mcp-utils one', async () => {
    const { matchBalanced } = await import('@chrischall/mcp-utils/scrape');
    for (const text of ['{"a":[1,{"b":"}"}]}x', "{'}':1}", '{[}]', '{"a":', '[1,[2],[3]]', 'x{}', '{"q":"\\"}"}']) {
      for (let i = 0; i < text.length; i++) {
        expect(skill.matchBalanced(text, i), `${text}@${i}`).toBe(matchBalanced(text, i));
      }
    }
  });
});
