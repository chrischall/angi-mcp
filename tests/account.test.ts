import { describe, it, expect } from 'vitest';
import { AngiClient } from '../src/client.js';
import type { AngiTransport, FetchInit, FetchResult } from '../src/transport.js';

/**
 * Fixtures mirror what my.angi.com actually returned for the reference account
 * on 2026-08-10 — including that the project and review lists were EMPTY. The
 * populated-record cases below use invented field names on purpose, to prove
 * records pass through untouched rather than being projected onto fields
 * nobody has observed.
 */
function nextDataPage(initialState: unknown): string {
  return `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    { props: { pageProps: { initialState } }, page: '/projects', buildId: 'x' }
  )}</script></body></html>`;
}

const EMPTY_ACCOUNT = {
  openProjectList: { projects: [], pagination: null },
  closedProjectList: { projects: [], pagination: null },
  projectHomeUser: {
    alUserId: 12345,
    entityId: 67890,
    entityHash: 'hash',
    firstName: 'Chris',
    email: null,
    unreadMessageCount: null,
  },
};

function stub(
  handler: (init: FetchInit) => Partial<FetchResult> & { body: string }
): AngiTransport & { calls: FetchInit[] } {
  const calls: FetchInit[] = [];
  return {
    calls,
    start: async () => {},
    close: async () => {},
    status: () => ({}),
    fetch: async (init) => {
      calls.push(init);
      return { status: 200, ...handler(init) };
    },
    runProbe: async () => ({}),
  };
}

describe('getAccount', () => {
  it('reads identity and project counts from the account app', async () => {
    const transport = stub(() => ({ body: nextDataPage(EMPTY_ACCOUNT) }));
    const account = await new AngiClient({ transport }).getAccount();
    expect(account).toMatchObject({
      firstName: 'Chris',
      userId: 12345,
      entityId: 67890,
      openProjectCount: 0,
      closedProjectCount: 0,
    });
  });

  it('requests my.angi.com, not www', async () => {
    const transport = stub(() => ({ body: nextDataPage(EMPTY_ACCOUNT) }));
    await new AngiClient({ transport }).getAccount();
    expect(transport.calls[0]).toMatchObject({ path: '/myprojects', subdomain: 'my' });
  });

  it('reports a signed-out session as such, not as an empty account', async () => {
    const transport = stub(() => ({
      body: '<html>login</html>',
      url: 'https://www.angi.com/auth/login?redirect=x',
    }));
    await expect(new AngiClient({ transport }).getAccount()).rejects.toThrow(/sign/i);
  });

  it('reads only the real <script id="__NEXT_DATA__"> tag, not the marker inside another script (fleet-audit#1145)', async () => {
    const decoy = '<script>var s = \'id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"initialState":{}}}}\';</script>';
    const transport = stub(() => ({ body: decoy + nextDataPage(EMPTY_ACCOUNT) }));
    const account = await new AngiClient({ transport }).getAccount();
    expect(account).toMatchObject({ firstName: 'Chris', userId: 12345 });
  });

  it('treats an unparseable __NEXT_DATA__ blob as missing', async () => {
    const transport = stub(() => ({
      body: '<script id="__NEXT_DATA__" type="application/json">{not json</script>',
    }));
    await expect(new AngiClient({ transport }).getAccount()).rejects.toThrow(/__NEXT_DATA__/);
  });

  it('errors clearly when the page carries no __NEXT_DATA__', async () => {
    const transport = stub(() => ({ body: '<html><body>nothing</body></html>' }));
    await expect(new AngiClient({ transport }).getAccount()).rejects.toThrow(/__NEXT_DATA__/);
  });
});

describe('listMyProjects', () => {
  it('returns both lists and flags that record fields are unverified', async () => {
    const transport = stub(() => ({ body: nextDataPage(EMPTY_ACCOUNT) }));
    const res = await new AngiClient({ transport }).listMyProjects();
    expect(res).toEqual({ open: [], closed: [], recordFieldsVerified: false });
  });

  it('filters to one list on request', async () => {
    const transport = stub(() => ({ body: nextDataPage(EMPTY_ACCOUNT) }));
    const client = new AngiClient({ transport });
    expect(await client.listMyProjects({ status: 'open' })).not.toHaveProperty('closed');
    expect(await client.listMyProjects({ status: 'closed' })).not.toHaveProperty('open');
  });

  it('passes populated records through byte-for-byte', async () => {
    // Field names here are deliberately arbitrary: nothing in the client may
    // depend on them, because no real project record has ever been observed.
    const project = { someUnknownField: 1, nested: { a: [1, 2] }, title: 'Fix sink' };
    const transport = stub(() => ({
      body: nextDataPage({
        ...EMPTY_ACCOUNT,
        openProjectList: { projects: [project], pagination: null },
      }),
    }));
    const res = await new AngiClient({ transport }).listMyProjects({ status: 'open' });
    expect(res.open).toEqual([project]);
  });
});

describe('listMyReviews', () => {
  it('returns the verified envelope', async () => {
    const transport = stub(() => ({ body: '{"unratedPros":[],"reviews":[]}' }));
    const res = await new AngiClient({ transport }).listMyReviews();
    expect(res).toEqual({ reviews: [], unratedPros: [], recordFieldsVerified: false });
  });

  it('hits the verified endpoint on my.angi.com', async () => {
    const transport = stub(() => ({ body: '{"unratedPros":[],"reviews":[]}' }));
    await new AngiClient({ transport }).listMyReviews();
    expect(transport.calls[0]).toMatchObject({
      path: '/account/rating-review/reviews',
      subdomain: 'my',
    });
  });

  it('treats a non-JSON 2xx as signed-out rather than parsing an interstitial', async () => {
    const transport = stub(() => ({ body: '<!doctype html><html>login page</html>' }));
    await expect(new AngiClient({ transport }).listMyReviews()).rejects.toThrow(/sign/i);
  });

  it('reports a Cloudflare challenge as a bot wall, not as signed-out', async () => {
    // fleet-audit#347: a 2xx challenge interstitial fails JSON.parse; telling the
    // user to sign in again sends recovery down the wrong path.
    const transport = stub(() => ({
      body: '<html><head><title>Just a moment...</title></head><body>_cf_chl_opt</body></html>',
    }));
    const err = await new AngiClient({ transport }).listMyReviews().catch((e) => e);
    expect(String(err.message)).toMatch(/Cloudflare/);
    expect(String(err.message)).not.toMatch(/sign in/i);
  });

  it('maps 401 to a sign-in error', async () => {
    const transport = stub(() => ({ status: 401, body: '<?xml version="1.0"?><responseStatus/>' }));
    await expect(new AngiClient({ transport }).listMyReviews()).rejects.toThrow(/sign/i);
  });

  it('tolerates a missing array rather than throwing', async () => {
    const transport = stub(() => ({ body: '{"reviews":null}' }));
    const res = await new AngiClient({ transport }).listMyReviews();
    expect(res.reviews).toEqual([]);
    expect(res.unratedPros).toEqual([]);
  });
});
