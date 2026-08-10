import { describe, it, expect, vi, afterEach } from 'vitest';
import { AngiClient, compactProvider, compactReview } from '../src/client.js';
import type { AngiTransport, FetchResult } from '../src/transport.js';

function makePage(rows: string[]): string {
  const lit = JSON.stringify(rows.join('\n')).slice(1, -1);
  return `<html><script>self.__next_f.push([1,"${lit}"])</script></html>`;
}
const row = (id: string, value: unknown) => `${id}:${JSON.stringify(value)}`;

const PROVIDER_ROWS = [
  row('3', {
    id: 'uuid-1',
    legacyId: '158675609',
    profileUrl: '/companylist/us/nc/monroe/superior-plumbing-reviews-1.htm',
    isSponsored: true,
    businessInfo: '$eb',
    rating: '$fb',
    contactInfo: { address: { city: 'Monroe', state: 'NC' } },
  }),
  row('eb', {
    businessName: 'Superior Plumbing and Drains',
    yearsInBusiness: 21,
    serviceArea: 'Serving Charlotte, NC',
    responseRate: 42,
    amenities: { emergencyServices: true, freeEstimates: false },
  }),
  row('fb', {
    reviewCount: 34,
    recommendedRate: 87,
    averageOverallRating: 4.5,
    averageRatings: { OVERALL: 4.65625, VALUE: 4.42 },
  }),
  // The duplicate a real search page emits for the sponsored slot.
  row('4', {
    id: 'uuid-1',
    legacyId: '158675609',
    profileUrl: '/companylist/us/nc/monroe/superior-plumbing-reviews-1.htm',
    businessInfo: '$eb',
    rating: '$fb',
  }),
];

const REVIEW_ROWS = [
  row('7', {
    reviewId: 'rev-1',
    rating: 5,
    text: 'Fast and tidy.',
    cost: 1500,
    reportDate: '2026-04-22T00:35:02.769099',
    userName: 'chris',
    isVerified: true,
    categories: '$b5',
    spComment: 'Thanks!',
  }),
  row('8', { reviewId: 'rev-2', rating: 2, text: 'Late.', reportDate: '2026-01-02T00:00:00' }),
  row('b5', [{ haId: 40111, name: 'Septic System Repair' }]),
];

function stubTransport(result: Partial<FetchResult> & { body: string }): AngiTransport & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    start: async () => {},
    close: async () => {},
    status: () => ({ connected: true }),
    fetch: async ({ path }) => {
      calls.push(path);
      return { status: 200, ...result };
    },
    runProbe: async () => ({ ok: true }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('buildSearchPath', () => {
  const client = new AngiClient({ transport: stubTransport({ body: '' }) });

  it('builds the company-list path', () => {
    expect(
      client.buildSearchPath({ trade: 'plumbing', state: 'NC', city: 'charlotte' })
    ).toBe('/companylist/us/nc/charlotte/plumbing.htm');
  });

  it('appends ?page only beyond page 1', () => {
    const args = { trade: 'plumbing', state: 'nc', city: 'charlotte' };
    expect(client.buildSearchPath({ ...args, page: 1 })).not.toContain('page=');
    expect(client.buildSearchPath({ ...args, page: 3 })).toContain('?page=3');
  });

  it('rejects a slug that could escape the path', () => {
    expect(() =>
      client.buildSearchPath({ trade: '../../etc/passwd', state: 'nc', city: 'charlotte' })
    ).toThrow(/Invalid trade/);
  });

  it('rejects a non-two-letter state', () => {
    expect(() =>
      client.buildSearchPath({ trade: 'plumbing', state: 'north-carolina', city: 'charlotte' })
    ).toThrow(/Invalid state/);
  });
});

describe('searchPros', () => {
  it('dedupes the doubled provider records', async () => {
    const transport = stubTransport({ body: makePage(PROVIDER_ROWS) });
    const client = new AngiClient({ transport });
    const res = await client.searchPros({ trade: 'plumbing', state: 'nc', city: 'charlotte' });
    expect(res.count).toBe(1);
    expect(transport.calls).toEqual(['/companylist/us/nc/charlotte/plumbing.htm']);
  });

  it('resolves references into the raw record', async () => {
    const client = new AngiClient({ transport: stubTransport({ body: makePage(PROVIDER_ROWS) }) });
    const res = await client.searchPros({ trade: 'plumbing', state: 'nc', city: 'charlotte' });
    const p = res.providers[0] as Record<string, any>;
    expect(p.businessInfo.businessName).toBe('Superior Plumbing and Drains');
    expect(p.rating.averageRatings.OVERALL).toBeCloseTo(4.65625);
  });

  it('projects compact records off documented fields', async () => {
    const client = new AngiClient({ transport: stubTransport({ body: makePage(PROVIDER_ROWS) }) });
    const res = await client.searchPros({
      trade: 'plumbing',
      state: 'nc',
      city: 'charlotte',
      compact: true,
    });
    expect(res.providers[0]).toMatchObject({
      name: 'Superior Plumbing and Drains',
      rating: 4.65625,
      displayRating: 4.5,
      reviewCount: 34,
      yearsInBusiness: 21,
      isSponsored: true,
      emergencyServices: true,
    });
  });

  it('returns RAW records, not nulls, when the payload shape drifts', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Angi renames businessInfo -> companyInfo: the record is still extractable
    // by legacyId, but every field the projection reads has moved.
    const drifted = makePage([
      row('3', {
        id: 'uuid-9',
        legacyId: '999',
        companyInfo: { businessName: 'Renamed Co' },
      }),
    ]);
    const client = new AngiClient({ transport: stubTransport({ body: drifted }) });
    const res = await client.searchPros({
      trade: 'plumbing',
      state: 'nc',
      city: 'charlotte',
      compact: true,
    });

    expect(res.count).toBe(1);
    // The outcome that matters: usable data survives the drift.
    expect(res.providers[0]).toMatchObject({
      legacyId: '999',
      companyInfo: { businessName: 'Renamed Co' },
    });
    expect(res.providers).not.toContain(null);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('returning raw records'));
    warn.mockRestore();
  });
});

describe('bot wall and HTTP errors', () => {
  it('raises an actionable error on a Cloudflare challenge served as 200', async () => {
    const client = new AngiClient({
      transport: stubTransport({
        body: '<html><head><title>Just a moment...</title></head><body>_cf_chl_opt</body></html>',
      }),
    });
    // The shared BotWallError owns the copy; what matters is that a challenge
    // served as 200 becomes a Cloudflare bot-wall error naming the path, rather
    // than being parsed into "no results found".
    await expect(
      client.searchPros({ trade: 'plumbing', state: 'nc', city: 'charlotte' })
    ).rejects.toThrow(/Cloudflare/);
    await expect(
      client.searchPros({ trade: 'plumbing', state: 'nc', city: 'charlotte' })
    ).rejects.toThrow(/\/companylist\/us\/nc\/charlotte\/plumbing\.htm/);
  });

  it('maps 404 to a slug hint', async () => {
    const client = new AngiClient({ transport: stubTransport({ status: 404, body: '' }) });
    await expect(
      client.searchPros({ trade: 'plumbing', state: 'nc', city: 'nowhere' })
    ).rejects.toThrow(/404/);
  });

  it('maps other non-2xx to unreachable', async () => {
    const client = new AngiClient({ transport: stubTransport({ status: 503, body: '' }) });
    await expect(
      client.searchPros({ trade: 'plumbing', state: 'nc', city: 'charlotte' })
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe('toPath', () => {
  it('passes a site-relative path through', () => {
    expect(AngiClient.toPath('/companylist/us/nc/x.htm')).toBe('/companylist/us/nc/x.htm');
  });

  it('strips the origin from a full angi.com URL', () => {
    expect(AngiClient.toPath('https://www.angi.com/companylist/us/nc/x.htm?page=2')).toBe(
      '/companylist/us/nc/x.htm?page=2'
    );
  });

  it('refuses a non-angi host', () => {
    expect(() => AngiClient.toPath('https://evil.example/steal')).toThrow(/only reads angi\.com/);
  });

  it('refuses a lookalike host', () => {
    expect(() => AngiClient.toPath('https://angi.com.evil.test/x')).toThrow(/only reads angi\.com/);
  });
});

describe('getReviews', () => {
  const client = () => new AngiClient({ transport: stubTransport({ body: makePage(REVIEW_ROWS) }) });

  it('returns every review with references resolved', async () => {
    const res = await client().getReviews('/companylist/us/nc/x.htm');
    expect(res.count).toBe(2);
    expect((res.reviews[0] as any).categories[0].name).toBe('Septic System Repair');
  });

  it('filters by rating', async () => {
    const res = await client().getReviews('/companylist/us/nc/x.htm', { minRating: 4 });
    expect(res.count).toBe(1);
  });

  it('honours limit', async () => {
    const res = await client().getReviews('/companylist/us/nc/x.htm', { limit: 1 });
    expect(res.count).toBe(1);
  });

  it('projects compact reviews', async () => {
    const res = await client().getReviews('/companylist/us/nc/x.htm', { compact: true });
    expect(res.reviews[0]).toMatchObject({
      reviewId: 'rev-1',
      rating: 5,
      cost: 1500,
      categories: ['Septic System Repair'],
      proResponse: 'Thanks!',
    });
  });
});

describe('getPro', () => {
  it('errors clearly when the page carries no provider record', async () => {
    const client = new AngiClient({ transport: stubTransport({ body: '<html></html>' }) });
    await expect(client.getPro('/companylist/us/nc/x.htm')).rejects.toThrow(
      /No provider record/
    );
  });

  it('reports the review count alongside the provider', async () => {
    const client = new AngiClient({
      transport: stubTransport({ body: makePage([...PROVIDER_ROWS, ...REVIEW_ROWS]) }),
    });
    const res = await client.getPro('/companylist/us/nc/x.htm');
    expect(res.reviewCount).toBe(2);
  });
});

describe('taxonomy (plain fetch, never the bridge)', () => {
  const sitemap = (locs: string[]) =>
    `<urlset>${locs.map((l) => `<loc>${l}</loc>`).join('')}</urlset>`;

  it('lists distinct sorted trade slugs', async () => {
    const sitemapFetch = vi.fn(async () =>
      new Response(
        sitemap([
          'https://www.angi.com/companylist/us/ak/plumbing.htm',
          'https://www.angi.com/companylist/us/al/plumbing.htm',
          'https://www.angi.com/companylist/us/ak/air-duct-cleaning.htm',
        ])
      )
    ) as unknown as typeof fetch;
    const transport = stubTransport({ body: '' });
    const client = new AngiClient({ transport, sitemapFetch });
    expect(await client.listTrades()).toEqual(['air-duct-cleaning', 'plumbing']);
    // The bridge must not be involved in taxonomy lookups.
    expect(transport.calls).toEqual([]);
  });

  it('lists cities for a trade and can filter by state', async () => {
    const sitemapFetch = vi.fn(async () =>
      new Response(
        sitemap([
          'https://www.angi.com/companylist/us/nc/charlotte/plumbing.htm',
          'https://www.angi.com/companylist/us/nc/raleigh/plumbing.htm',
          'https://www.angi.com/companylist/us/sc/rock-hill/plumbing.htm',
        ])
      )
    ) as unknown as typeof fetch;
    const client = new AngiClient({ transport: stubTransport({ body: '' }), sitemapFetch });
    expect(await client.listCities('plumbing', { state: 'nc' })).toEqual([
      { state: 'nc', city: 'charlotte' },
      { state: 'nc', city: 'raleigh' },
    ]);
  });

  it('surfaces a sitemap HTTP failure', async () => {
    const sitemapFetch = vi.fn(
      async () => new Response('', { status: 500 })
    ) as unknown as typeof fetch;
    const client = new AngiClient({ transport: stubTransport({ body: '' }), sitemapFetch });
    await expect(client.listTrades()).rejects.toThrow(/HTTP 500/);
  });
});

describe('compact projections', () => {
  it('returns null for a record that is not a provider', () => {
    expect(compactProvider({ foo: 1 } as Record<string, unknown>)).toBeNull();
  });

  it('returns null for a record that is not a review', () => {
    expect(compactReview({ foo: 1 } as Record<string, unknown>)).toBeNull();
  });

  it('falls back to starRating when rating is absent', () => {
    expect(compactReview({ reviewId: 'r', starRating: 4 })).toMatchObject({ rating: 4 });
  });
});

describe('projection of unresolved refs and HTML entities', () => {
  it('drops a review body that is still an unresolved RSC token', async () => {
    // Observed live: one of 50 review bodies referenced a row the page never
    // sent. Emitting the literal "$58" would read like the review text.
    const client = new AngiClient({
      transport: stubTransport({
        body: makePage([row('7', { reviewId: 'r1', rating: 5, text: '$58' })]),
      }),
    });
    const res = await client.getReviews('/companylist/us/nc/x.htm', { compact: true });
    expect((res.reviews[0] as any).text).toBeUndefined();
    expect(JSON.stringify(res.reviews)).not.toContain('$58');
  });

  it('decodes the HTML entities Angi ships in its text', async () => {
    // Live payload contained e.g. "Angie&#39;s List" and "&amp;".
    const client = new AngiClient({
      transport: stubTransport({
        body: makePage([
          row('7', {
            reviewId: 'r1',
            rating: 5,
            text: 'Called Angie&#39;s List &amp; they helped',
            spComment: 'Thanks &amp; welcome',
          }),
        ]),
      }),
    });
    const res = await client.getReviews('/companylist/us/nc/x.htm', { compact: true });
    expect((res.reviews[0] as any).text).toBe("Called Angie's List & they helped");
    expect((res.reviews[0] as any).proResponse).toBe('Thanks & welcome');
  });

  it('decodes entities in a provider name', async () => {
    const client = new AngiClient({
      transport: stubTransport({
        body: makePage([
          row('3', { id: 'u1', legacyId: '1', businessInfo: '$eb', rating: '$fb' }),
          row('eb', { businessName: 'MKB Plumbing &amp; Septic LLC' }),
          row('fb', { reviewCount: 3, averageRatings: { OVERALL: 4.2 } }),
        ]),
      }),
    });
    const res = await client.searchPros({
      trade: 'plumbing',
      state: 'nc',
      city: 'charlotte',
      compact: true,
    });
    expect((res.providers[0] as any).name).toBe('MKB Plumbing & Septic LLC');
  });

  it('keeps a review whose only body is an unresolved token, when it has a rating', () => {
    expect(compactReview({ reviewId: 'r', rating: 4, text: '$58' })).toMatchObject({ rating: 4 });
  });

  it('rejects a review with neither a rating nor a resolvable body', () => {
    expect(compactReview({ reviewId: 'r', text: '$58' })).toBeNull();
  });
});
