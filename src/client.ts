// Angi client.
//
// Two paths, deliberately:
//   - Content pages (search, profiles) go through the browser bridge, because
//     Cloudflare 403s every server-side request to www.angi.com.
//   - Sitemaps (the trade/city taxonomy) are fetched with plain node fetch —
//     they answer server-side, so routing them through the tab buys nothing.

import {
  McpToolError,
  BotWallError,
  UnreachableError,
  SessionNotAuthenticatedError,
} from '@chrischall/mcp-utils';
import {
  isCloudflareChallenge,
  extractJsonAfterMarker,
  decodeHtmlEntities,
} from '@chrischall/mcp-utils/scrape';

/**
 * A field still holding an RSC reference token (`"$58"`) means the row it
 * pointed at never arrived in the payload — observed on a live profile page
 * where one of 50 review bodies was missing. Surfacing the token would read
 * like content, so treat it as absent.
 */
function resolvedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^\$[0-9a-f]+$/.test(value)) return undefined;
  // Angi's payload is HTML-escaped (`Angie&#39;s`, `&amp;`), so decode for the
  // projected views. Raw records are left exactly as Angi sent them.
  return decodeHtmlEntities(value);
}
import { recordsFromHtml, dedupeById } from './parse.js';
import type { AngiTransport } from './transport.js';

export const ORIGIN = 'https://www.angi.com';

/** Extraction key for the provider wrapper on a search / company-list page. */
const PROVIDER_KEY = 'legacyId';
/** Extraction key for review records on a pro profile page. */
const REVIEW_KEY = 'reviewId';

/** Slugs appear directly in a URL path, so keep them to the observed shape. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATE_RE = /^[a-z]{2}$/;

function assertSlug(value: string, label: string): string {
  const v = value.trim().toLowerCase();
  if (!SLUG_RE.test(v)) {
    throw new McpToolError(
      `Invalid ${label} "${value}" — expected a lowercase hyphenated slug such as "air-duct-cleaning".`,
      { hint: `Use angi_list_trades / angi_list_cities to get valid ${label} slugs.` }
    );
  }
  return v;
}

function assertState(value: string): string {
  const v = value.trim().toLowerCase();
  if (!STATE_RE.test(v)) {
    throw new McpToolError(
      `Invalid state "${value}" — expected a two-letter US state code such as "nc".`
    );
  }
  return v;
}

export interface ProviderRating {
  reviewCount?: number;
  recommendedRate?: number;
  averageOverallRating?: number;
  averageRatings?: Record<string, number>;
  bestReview?: { reviewId?: string; comment?: string; createdOn?: string };
}

export interface CompactProvider {
  id?: string;
  legacyId?: string;
  name?: string;
  profileUrl?: string;
  /** Unrounded overall rating. Prefer this over the rounded display value. */
  rating?: number;
  /** Rounded display value Angi shows on the card. */
  displayRating?: number;
  reviewCount?: number;
  recommendedRate?: number;
  yearsInBusiness?: number;
  city?: string;
  state?: string;
  serviceArea?: string;
  responseRate?: number;
  isSponsored?: boolean;
  emergencyServices?: boolean;
  freeEstimates?: boolean;
}

/**
 * Project a provider to a slim summary using documented fields only. Returns
 * null when the record does not look like a provider, so callers can fall back
 * to the raw response rather than emitting an empty projection.
 */
export function compactProvider(raw: Record<string, unknown>): CompactProvider | null {
  if (!raw || typeof raw !== 'object') return null;
  const info = (raw.businessInfo ?? {}) as Record<string, unknown>;
  const rating = (raw.rating ?? {}) as ProviderRating;
  const address = ((raw.contactInfo as Record<string, unknown>)?.address ??
    {}) as Record<string, unknown>;
  const amenities = (info.amenities ?? {}) as Record<string, unknown>;
  const name = info.businessName;
  // Records are extracted by their `legacyId` key, so testing that would never
  // fail and the drift fallback would be dead code. Gate on the nested field
  // the projection actually depends on: if Angi renames or moves businessInfo,
  // every projection goes null and searchPros hands back the raw records.
  if (typeof name !== 'string') return null;
  const averages = rating.averageRatings ?? {};
  return {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    legacyId: typeof raw.legacyId === 'string' ? raw.legacyId : undefined,
    name: resolvedText(name),
    profileUrl: typeof raw.profileUrl === 'string' ? raw.profileUrl : undefined,
    rating: typeof averages.OVERALL === 'number' ? averages.OVERALL : undefined,
    displayRating: rating.averageOverallRating,
    reviewCount: rating.reviewCount,
    recommendedRate: rating.recommendedRate,
    yearsInBusiness:
      typeof info.yearsInBusiness === 'number' ? info.yearsInBusiness : undefined,
    city: typeof address.city === 'string' ? address.city : undefined,
    state: typeof address.state === 'string' ? address.state : undefined,
    serviceArea: resolvedText(info.serviceArea),
    responseRate:
      typeof info.responseRate === 'number' ? info.responseRate : undefined,
    isSponsored: typeof raw.isSponsored === 'boolean' ? raw.isSponsored : undefined,
    emergencyServices:
      typeof amenities.emergencyServices === 'boolean'
        ? amenities.emergencyServices
        : undefined,
    freeEstimates:
      typeof amenities.freeEstimates === 'boolean' ? amenities.freeEstimates : undefined,
  };
}

export interface CompactReview {
  reviewId?: string;
  rating?: number;
  text?: string;
  cost?: number;
  date?: string;
  userName?: string;
  isVerified?: boolean;
  categories?: string[];
  /** The pro's public response, when they left one. */
  proResponse?: string;
}

export function compactReview(raw: Record<string, unknown>): CompactReview | null {
  if (!raw || typeof raw !== 'object' || raw.reviewId === undefined) return null;
  // Same reasoning as compactProvider: reviews are extracted by `reviewId`, so
  // require a field the projection actually reads. A review with neither a
  // rating nor body text means the shape moved.
  const hasRating =
    typeof raw.rating === 'number' || typeof raw.starRating === 'number';
  if (!hasRating && resolvedText(raw.text) === undefined) return null;
  const cats = Array.isArray(raw.categories)
    ? (raw.categories as Record<string, unknown>[])
        .map((c) => c?.name)
        .filter((n): n is string => typeof n === 'string')
    : undefined;
  const rating = typeof raw.rating === 'number' ? raw.rating : raw.starRating;
  return {
    reviewId: typeof raw.reviewId === 'string' ? raw.reviewId : undefined,
    rating: typeof rating === 'number' ? rating : undefined,
    text: resolvedText(raw.text),
    cost: typeof raw.cost === 'number' ? raw.cost : undefined,
    date: typeof raw.reportDate === 'string' ? raw.reportDate : undefined,
    userName: typeof raw.userName === 'string' ? raw.userName : undefined,
    isVerified: typeof raw.isVerified === 'boolean' ? raw.isVerified : undefined,
    categories: cats,
    proResponse: resolvedText(raw.spComment),
  };
}

export interface AngiClientOptions {
  transport: AngiTransport;
  /** Injectable for tests; defaults to global fetch (used only for sitemaps). */
  sitemapFetch?: typeof fetch;
}

export interface SearchArgs {
  trade: string;
  state: string;
  city: string;
  page?: number;
  compact?: boolean;
}

export interface SearchResult {
  url: string;
  trade: string;
  state: string;
  city: string;
  page: number;
  count: number;
  providers: unknown[];
}

export class AngiClient {
  private readonly transport: AngiTransport;
  private readonly sitemapFetch: typeof fetch;

  constructor(opts: AngiClientOptions) {
    this.transport = opts.transport;
    this.sitemapFetch = opts.sitemapFetch ?? globalThis.fetch;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /** Fetch a content page through the browser bridge and return its HTML. */
  async fetchHtml(path: string): Promise<string> {
    const res = await this.transport.fetch({ method: 'GET', path });
    if (res.status === 404) {
      throw new McpToolError(`Angi returned 404 for ${path}.`, {
        hint: 'Check the trade and city slugs with angi_list_trades / angi_list_cities.',
      });
    }
    if (res.status < 200 || res.status >= 300) {
      throw new UnreachableError(`Angi returned HTTP ${res.status} for ${path}.`);
    }
    // A 2xx that is a challenge page means the tab lost its Cloudflare
    // clearance — surface that as actionable rather than parsing the
    // interstitial and reporting "no results".
    if (isCloudflareChallenge(res.body)) {
      throw new BotWallError(path, undefined, { vendor: 'Cloudflare' });
    }
    return res.body;
  }

  buildSearchPath({ trade, state, city, page = 1 }: SearchArgs): string {
    const t = assertSlug(trade, 'trade');
    const s = assertState(state);
    const c = assertSlug(city, 'city');
    const base = `/companylist/us/${s}/${c}/${t}.htm`;
    return page > 1 ? `${base}?page=${page}` : base;
  }

  async searchPros(args: SearchArgs): Promise<SearchResult> {
    const path = this.buildSearchPath(args);
    const html = await this.fetchHtml(path);
    const raw = dedupeById(
      recordsFromHtml(html, PROVIDER_KEY) as { id?: unknown }[]
    ) as Record<string, unknown>[];

    let providers: unknown[] = raw;
    if (args.compact) {
      const projected = raw.map(compactProvider);
      // Drift guard: if the payload no longer looks like providers, hand back
      // the raw records rather than a list of nulls.
      if (projected.some((p) => p === null)) {
        console.error(
          `[angi-mcp] compact projection failed for ${projected.filter((p) => p === null).length}/${projected.length} records on ${path}; returning raw records.`
        );
      } else {
        providers = projected;
      }
    }
    return {
      url: `${ORIGIN}${path}`,
      trade: args.trade.toLowerCase(),
      state: args.state.toLowerCase(),
      city: args.city.toLowerCase(),
      page: args.page ?? 1,
      count: providers.length,
      providers,
    };
  }

  /** Normalise a profile URL or path to a site-relative path. */
  static toPath(profileUrl: string): string {
    const v = profileUrl.trim();
    if (v.startsWith('/')) return v;
    let parsed: URL;
    try {
      parsed = new URL(v);
    } catch {
      throw new McpToolError(`"${profileUrl}" is not a valid Angi URL or path.`);
    }
    if (!/(^|\.)angi\.com$/.test(parsed.hostname)) {
      throw new McpToolError(
        `Refusing to fetch ${parsed.hostname} — this server only reads angi.com.`
      );
    }
    return `${parsed.pathname}${parsed.search}`;
  }

  async getPro(
    profileUrl: string,
    { compact = false }: { compact?: boolean } = {}
  ): Promise<{ url: string; provider: unknown; reviewCount: number }> {
    const path = AngiClient.toPath(profileUrl);
    const html = await this.fetchHtml(path);
    const [raw] = recordsFromHtml(html, PROVIDER_KEY, { limit: 1 });
    if (!raw) {
      throw new McpToolError(`No provider record found on ${path}.`, {
        hint: 'The URL may not be a pro profile page, or Angi changed the page shape.',
      });
    }
    const reviews = recordsFromHtml(html, REVIEW_KEY);
    const projected = compact ? compactProvider(raw) : null;
    return {
      url: `${ORIGIN}${path}`,
      provider: projected ?? raw,
      reviewCount: reviews.length,
    };
  }

  async getReviews(
    profileUrl: string,
    {
      compact = false,
      minRating,
      maxRating,
      limit,
    }: { compact?: boolean; minRating?: number; maxRating?: number; limit?: number } = {}
  ): Promise<{ url: string; count: number; reviews: unknown[] }> {
    const path = AngiClient.toPath(profileUrl);
    const html = await this.fetchHtml(path);
    let raw = recordsFromHtml(html, REVIEW_KEY);
    if (minRating !== undefined) {
      raw = raw.filter((r) => typeof r.rating === 'number' && r.rating >= minRating);
    }
    if (maxRating !== undefined) {
      raw = raw.filter((r) => typeof r.rating === 'number' && r.rating <= maxRating);
    }
    if (limit !== undefined) raw = raw.slice(0, limit);

    let reviews: unknown[] = raw;
    if (compact) {
      const projected = raw.map(compactReview);
      if (projected.some((p) => p === null)) {
        console.error(
          `[angi-mcp] compact projection failed for ${projected.filter((p) => p === null).length}/${projected.length} reviews on ${path}; returning raw records.`
        );
      } else {
        reviews = projected;
      }
    }
    return { url: `${ORIGIN}${path}`, count: reviews.length, reviews };
  }

  // --- taxonomy: plain fetch, no bridge -------------------------------------

  private async getSitemap(path: string): Promise<string> {
    const url = `${ORIGIN}${path}`;
    let res: Response;
    try {
      res = await this.sitemapFetch(url);
    } catch (err) {
      throw new UnreachableError(
        `Could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!res.ok) {
      throw new UnreachableError(`Angi returned HTTP ${res.status} for ${url}.`);
    }
    return res.text();
  }

  private static locs(xml: string): string[] {
    return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  }

  /** Every trade slug Angi publishes (~312). */
  async listTrades(): Promise<string[]> {
    const xml = await this.getSitemap('/sitemap/statecat-sitemap.xml');
    const slugs = new Set<string>();
    for (const loc of AngiClient.locs(xml)) {
      const m = loc.match(/\/companylist\/us\/[a-z]{2}\/([^/]+)\.htm/);
      if (m) slugs.add(m[1]);
    }
    return [...slugs].sort();
  }

  /** Every state/city that publishes pages for one trade. */
  async listCities(
    trade: string,
    { state }: { state?: string } = {}
  ): Promise<{ state: string; city: string }[]> {
    const t = assertSlug(trade, 'trade');
    const wanted = state ? assertState(state) : undefined;
    const xml = await this.getSitemap(`/sitemap/angi-geocat-${t}.xml`);
    const seen = new Set<string>();
    const out: { state: string; city: string }[] = [];
    for (const loc of AngiClient.locs(xml)) {
      const m = loc.match(/\/companylist\/us\/([a-z]{2})\/([^/]+)\//);
      if (!m) continue;
      if (wanted && m[1] !== wanted) continue;
      const key = `${m[1]}/${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ state: m[1], city: m[2] });
    }
    return out;
  }

  // --- signed-in account (my.angi.com) --------------------------------------
  //
  // A different app from www.angi.com: Pages Router, so its data is a plain
  // `__NEXT_DATA__` JSON blob rather than the RSC flight rows `parse.ts`
  // handles. Auth is the session cookie, which rides the tab automatically.

  /** Fetch a my.angi.com page and return its __NEXT_DATA__ payload. */
  private async fetchAccountNextData(path: string): Promise<Record<string, unknown>> {
    const res = await this.transport.fetch({ method: 'GET', path, subdomain: 'my' });
    if (res.status < 200 || res.status >= 300) {
      throw new UnreachableError(`Angi returned HTTP ${res.status} for my.angi.com${path}.`);
    }
    if (isCloudflareChallenge(res.body)) {
      throw new BotWallError(path, undefined, { vendor: 'Cloudflare' });
    }
    // Signed-out requests are bounced to the login page rather than 401'd.
    if (/\/auth\/login/.test(res.url ?? '')) {
      throw new SessionNotAuthenticatedError('Angi', 'www.angi.com');
    }
    const data = extractJsonAfterMarker(res.body, [
      'id="__NEXT_DATA__" type="application/json">',
      'id="__NEXT_DATA__"',
    ]) as Record<string, unknown> | null;
    if (!data) {
      throw new McpToolError(`No __NEXT_DATA__ payload on my.angi.com${path}.`, {
        hint: 'Confirm the browser tab is signed in to Angi; signed-out requests are redirected to the login page.',
      });
    }
    return data;
  }

  private static initialState(nextData: Record<string, unknown>): Record<string, unknown> {
    const props = (nextData.props ?? {}) as Record<string, unknown>;
    const pageProps = (props.pageProps ?? {}) as Record<string, unknown>;
    return (pageProps.initialState ?? pageProps) as Record<string, unknown>;
  }

  /** The signed-in user's identity and project counts. */
  async getAccount(): Promise<Record<string, unknown>> {
    const state = AngiClient.initialState(await this.fetchAccountNextData('/myprojects'));
    const user = (state.projectHomeUser ?? {}) as Record<string, unknown>;
    const open = ((state.openProjectList ?? {}) as Record<string, unknown>).projects;
    const closed = ((state.closedProjectList ?? {}) as Record<string, unknown>).projects;
    return {
      firstName: user.firstName,
      userId: user.alUserId,
      entityId: user.entityId,
      email: user.email ?? null,
      unreadMessageCount: user.unreadMessageCount ?? null,
      openProjectCount: Array.isArray(open) ? open.length : null,
      closedProjectCount: Array.isArray(closed) ? closed.length : null,
    };
  }

  /**
   * The signed-in user's projects. Records are returned RAW: the reference
   * account carried zero projects, so no per-record field has ever been
   * observed and projecting invented fields would be a guess.
   */
  async listMyProjects({ status = 'all' }: { status?: 'open' | 'closed' | 'all' } = {}): Promise<{
    open?: unknown[];
    closed?: unknown[];
    recordFieldsVerified: false;
  }> {
    const state = AngiClient.initialState(await this.fetchAccountNextData('/myprojects'));
    const pick = (key: string) => {
      const list = (state[key] ?? {}) as Record<string, unknown>;
      return Array.isArray(list.projects) ? (list.projects as unknown[]) : [];
    };
    return {
      ...(status !== 'closed' ? { open: pick('openProjectList') } : {}),
      ...(status !== 'open' ? { closed: pick('closedProjectList') } : {}),
      recordFieldsVerified: false,
    };
  }

  /**
   * Reviews the signed-in user has written, plus pros they were prompted to
   * rate. Same caveat as projects: the envelope is verified, the record shape
   * is not, so records pass through raw.
   */
  async listMyReviews(): Promise<{
    reviews: unknown[];
    unratedPros: unknown[];
    recordFieldsVerified: false;
  }> {
    const res = await this.transport.fetch({
      method: 'GET',
      path: '/account/rating-review/reviews',
      subdomain: 'my',
      headers: { accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      throw new SessionNotAuthenticatedError('Angi', 'www.angi.com');
    }
    if (res.status < 200 || res.status >= 300) {
      throw new UnreachableError(
        `Angi returned HTTP ${res.status} for my.angi.com/account/rating-review/reviews.`
      );
    }
    let body: { reviews?: unknown[]; unratedPros?: unknown[] };
    try {
      body = JSON.parse(res.body);
    } catch {
      // A non-JSON 2xx here is a login page or an interstitial, not data.
      throw new SessionNotAuthenticatedError('Angi', 'www.angi.com');
    }
    return {
      reviews: Array.isArray(body.reviews) ? body.reviews : [],
      unratedPros: Array.isArray(body.unratedPros) ? body.unratedPros : [],
      recordFieldsVerified: false,
    };
  }

  async probe(): Promise<unknown> {
    // Probe through fetchHtml so the challenge/HTTP guards the real tools rely
    // on are exercised too, not just raw bridge reachability.
    return this.transport.runProbe((path: string) => this.fetchHtml(path), '/robots.txt');
  }

  bridgeStatus() {
    return this.transport.status();
  }
}
