import { describe, it, expect } from 'vitest';
import {
  flightText,
  flightRows,
  resolveRefs,
  objectsWithKey,
  recordsFromHtml,
  dedupeById,
} from '../src/parse.js';

/**
 * Build a page in Angi's real wire format: flight rows joined by newlines,
 * JS-string-escaped, then split across two `self.__next_f.push` calls so the
 * tests cover a payload that straddles a chunk boundary (which is why the
 * chunks must be concatenated before parsing, not parsed individually).
 */
function makePage(rows: string[], { chunks = 2 } = {}): string {
  const text = rows.join('\n');
  const lit = JSON.stringify(text).slice(1, -1);
  const size = Math.ceil(lit.length / chunks);
  let html = '<html>';
  for (let i = 0; i < lit.length; i += size) {
    html += `<script>self.__next_f.push([1,"${lit.slice(i, i + size)}"])</script>`;
  }
  return `${html}</html>`;
}

const row = (id: string, value: unknown) => `${id}:${JSON.stringify(value)}`;

describe('flightText', () => {
  it('concatenates and unescapes pushed chunks', () => {
    const rows = [row('3', { a: 1 }), row('4', { b: 'two' })];
    expect(flightText(makePage(rows))).toBe(rows.join('\n'));
  });

  it('reassembles a record split across a chunk boundary', () => {
    const rows = [row('3', { legacyId: '158675609', name: 'Superior Plumbing' })];
    const recs = recordsFromHtml(makePage(rows, { chunks: 5 }), 'legacyId');
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe('Superior Plumbing');
  });

  it('skips a malformed chunk instead of throwing', () => {
    expect(flightText('<script>self.__next_f.push([1,"\\uZZZZ"])</script>')).toBe('');
  });

  it('returns empty string for a page with no flight payload', () => {
    expect(flightText('<html><body>nothing here</body></html>')).toBe('');
  });
});

describe('flightRows', () => {
  it('indexes JSON rows and ignores module/preload directives', () => {
    const text = [
      '1:HL["https://cdn.example/app.css","style"]',
      '2:I["4512",["static/chunk.js"],"Default"]',
      row('eb', { businessName: 'Superior Plumbing' }),
    ].join('\n');
    const rows = flightRows(text);
    expect([...rows.keys()]).toEqual(['eb']);
  });
});

describe('resolveRefs', () => {
  const rows = flightRows(
    [
      row('b5', ['$b6']),
      row('b6', { name: 'Septic System Repair' }),
      row('c0', '$c1'),
      row('c1', '$c0'),
    ].join('\n')
  );

  it('follows a chained reference', () => {
    expect(resolveRefs({ categories: '$b5' }, rows)).toEqual({
      categories: [{ name: 'Septic System Repair' }],
    });
  });

  it('drops $undefined and unescapes $$', () => {
    expect(resolveRefs({ a: '$undefined', b: '$$literal' }, rows)).toEqual({
      b: '$literal',
    });
  });

  it('leaves an unknown row reference untouched', () => {
    expect(resolveRefs({ a: '$deadbeef' }, rows)).toEqual({ a: '$deadbeef' });
  });

  it('terminates on a reference cycle', () => {
    expect(() => resolveRefs({ a: '$c0' }, rows)).not.toThrow();
  });

  it('leaves ordinary strings that merely start with $ alone', () => {
    expect(resolveRefs({ price: '$1,500' }, rows)).toEqual({ price: '$1,500' });
  });
});

describe('objectsWithKey', () => {
  const provider = (id: string, legacyId: string) => ({
    id,
    legacyId,
    businessInfo: '$eb',
    rating: '$fb',
  });
  const page = makePage([
    row('3', provider('uuid-1', '158675609')),
    row('eb', { businessName: 'Superior Plumbing', yearsInBusiness: 21 }),
    row('fb', { reviewCount: 34, averageRatings: { OVERALL: 4.65625 } }),
    row('4', provider('uuid-1', '158675609')), // the duplicate a real page emits
    row('5', provider('uuid-2', '139711701')),
  ]);

  it('extracts every object owning the key, references resolved', () => {
    const pros = recordsFromHtml(page, 'legacyId');
    expect(pros).toHaveLength(3);
    expect(pros[0].businessInfo).toEqual({
      businessName: 'Superior Plumbing',
      yearsInBusiness: 21,
    });
  });

  it('honours limit', () => {
    expect(recordsFromHtml(page, 'legacyId', { limit: 1 })).toHaveLength(1);
  });

  it('keeps raw reference tokens when resolve is false', () => {
    const [first] = recordsFromHtml(page, 'legacyId', { limit: 1, resolve: false });
    expect(first.businessInfo).toBe('$eb');
  });

  it('returns nothing for an absent key', () => {
    expect(recordsFromHtml(page, 'noSuchKey')).toEqual([]);
  });

  it('does not match a key that only appears nested in another object', () => {
    // `businessName` lives on row eb, not on the provider wrapper.
    const recs = recordsFromHtml(page, 'businessName');
    expect(recs.every((r) => 'businessName' in r)).toBe(true);
  });
});

describe('dedupeById', () => {
  it('collapses the duplicate a search page emits, preserving order', () => {
    const items = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'a', n: 3 }];
    expect(dedupeById(items).map((i) => i.n)).toEqual([1, 2]);
  });

  it('keeps records that carry no id rather than collapsing them together', () => {
    const items = [{ n: 1 }, { n: 2 }] as { id?: string; n: number }[];
    expect(dedupeById(items)).toHaveLength(2);
  });
});

describe('text chunks (RSC `T<hexLength>,` rows)', () => {
  // Long strings — review bodies especially — are not sent as JSON. They are
  // raw text chunks whose length is a hex BYTE count. Missing this left the
  // referring field holding a literal "$b6" that reads like content; verified
  // against a live profile page where 4 of 50 bodies arrived this way.
  const page = (rows: string[]) => {
    const lit = JSON.stringify(rows.join('\n')).slice(1, -1);
    return `<html><script>self.__next_f.push([1,"${lit}"])</script></html>`;
  };

  it('reads a text chunk by byte length and resolves the reference', () => {
    const body = 'I am just blown away. Micheal came to assess our issues.';
    const rows = [
      `3:${JSON.stringify({ reviewId: 'r1', rating: 5, text: '$b6' })}`,
      `b6:T${body.length.toString(16)},${body}`,
    ];
    const [rec] = recordsFromHtml(page(rows), 'reviewId');
    expect(rec.text).toBe(body);
  });

  it('counts UTF-8 bytes, not characters', () => {
    const body = 'café — naïve';                       // multi-byte characters
    const byteLen = new TextEncoder().encode(body).length;
    expect(byteLen).toBeGreaterThan(body.length);       // guard the premise
    const rows = [
      `3:${JSON.stringify({ reviewId: 'r1', text: '$b6' })}`,
      `b6:T${byteLen.toString(16)},${body}`,
      `b7:${JSON.stringify({ unrelated: true })}`,
    ];
    const [rec] = recordsFromHtml(page(rows), 'reviewId');
    expect(rec.text).toBe(body);
  });

  it('handles a text chunk containing newlines', () => {
    const body = 'line one\nline two\nline three';
    const rows = [
      `3:${JSON.stringify({ reviewId: 'r1', text: '$b6' })}`,
      `b6:T${new TextEncoder().encode(body).length.toString(16)},${body}`,
    ];
    const [rec] = recordsFromHtml(page(rows), 'reviewId');
    expect(rec.text).toBe(body);
  });

  it('leaves the token in place when the row never arrived', () => {
    // Observed live: one referenced row was simply absent from the payload.
    const [rec] = recordsFromHtml(
      page([`3:${JSON.stringify({ reviewId: 'r1', text: '$58' })}`]),
      'reviewId'
    );
    expect(rec.text).toBe('$58');
  });
});
