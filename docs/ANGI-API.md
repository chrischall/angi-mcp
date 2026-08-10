# Angi request/response shapes

Captured live from angi.com on **2026-08-10** (Charlotte, NC / plumbing).
Structure only — no cookies, tokens or session values are recorded here.

## Reachability: why this MCP needs the browser bridge

Probed server-side with a normal desktop User-Agent:

| URL | Result |
| --- | --- |
| `https://www.angi.com/` | **403** Cloudflare (`<title>Attention Required!`) |
| `https://www.angi.com/companylist/us/nc/charlotte/plumbing.htm` | **403** Cloudflare |
| `https://www.angi.com/nearme/plumbers/` | **403** Cloudflare |
| `https://www.angi.com/auth/login` | 200 |
| `https://www.angi.com/robots.txt` | 200 |
| `https://www.angi.com/sitemap/*.xml` | 200 |
| `https://api.angi.com/` | 404 |
| `https://developer.angi.com/` | does not resolve |
| `https://api.homeadvisor.com/` | 404 |

Conclusion: **there is no consumer API**, and every data-bearing page is
Cloudflare-walled server-side. The wall clears for a real browser, so content
pages are fetched through the user's own tab (`@fetchproxy/server`). The
sitemaps answer server-side, so the taxonomy tools use plain node `fetch` and
never touch the bridge.

Lifting `cf_clearance` out of the browser does not help: it is bound to IP +
User-Agent + TLS fingerprint together. This is also why angi-mcp **cannot be
hosted on mcp-host** — see the fleet notes on browser-bridge repos.

## Where the data lives

The search page issues **zero XHR** on load or pagination. Angi is Next.js App
Router, so records arrive as React Server Component flight rows:

```html
<script>self.__next_f.push([1,"<JS-string-literal>"])</script>
```

A profile page carried **42** such chunks. Concatenating the unescaped literals
gives newline-separated rows `<hexid>:<json>` (297 rows on that page). Nested
values are deduplicated across rows, so a field can hold a reference:

```
3:{"…","categories":"$b5"}
b5:["$b6"]
b6:{"haId":40111,"name":"Septic System Repair"}
```

References **chain**, `"$undefined"` means undefined, and `"$$x"` is an escaped
literal `"$x"`. `src/parse.ts` implements this; `objectsWithKey` brace-matches
the objects owning a key and resolves the references.

### Text chunks — long strings are not JSON

RSC sends a long string as its own row: `<id>:T<hexByteLength>,<raw text>`,
referenced from the record as `"$b6"`. The length is a **UTF-8 byte** count and
the chunk may contain newlines, so a line-splitting row parser misses it
entirely and leaves `text: "$b6"` — which reads like content.

Verified on a live profile page: **4 of 50 review bodies** arrived this way,
longest 1,136 characters. A fifth referenced a row the page never sent; that
token cannot be resolved, so `compactReview` treats a value matching
`^\$[0-9a-f]+$` as absent rather than emitting it as text.

Angi's payload is also **HTML-escaped** (`Angie&#39;s`, `&amp;`). The compact
projections decode entities; raw records are passed through exactly as sent.

JSON-LD is also present (`SearchResultsPage`, `ItemList`, `LocalBusiness`,
`FAQPage`, `BreadcrumbList`) and is real JSON — but it carries only names,
addresses, profile URLs and one sample review. **No ratings, no review counts,
no ids.** It is a cross-check, not the source.

## 1. Search — `GET /companylist/us/<state>/<city>/<trade>.htm[?page=N]`

Extraction key: **`legacyId`**. 20 records per page → **10 unique**; every
provider is emitted twice (sponsored slot + list row), so dedupe on `id`.
Pages 1 and 2 were verified to have zero overlap.

Provider record, references resolved:

```jsonc
{
  "id": "019bea94-1c41-11ee-b010-12f6eb045c11",   // stable uuid
  "legacyId": "158675609",
  "profileUrl": "/companylist/us/nc/monroe/superior-plumbing-and-drains-reviews-1.htm",
  "logoPhotoUrl": "https://cdn.homeadvisor.com/…",
  "businessType": "LEADS",
  "isSponsored": true,
  "isCorporateAccount": false,
  "recentLeadCount": 2,
  "businessInfo": {
    "businessName": "Superior Plumbing and Drains",
    "businessDescription": "…",
    "yearsInBusiness": 21,
    "serviceArea": "Serving Charlotte, NC and surrounding areas",
    "responseRate": 42,          // percent
    "responseTime": "1223",      // string; units undocumented — passed through
    "isAdvertiser": true,
    "amenities": {
      "acceptedPaymentMethods": ["CREDIT_CARD"],
      "emergencyServices": true, "freeEstimates": false, "warrantiesOffered": true,
      "bilingual": false, "veteranOwned": false,
      "smallJobsWelcome": false, "offersCommercialServices": false
    },
    "serviceHours": [...], "presentationCapabilities": {...}, "xmDisplayUrl": "…"
  },
  "contactInfo": { "address": { "street1": "…", "city": "Monroe", "state": "NC", "postalCode": "28110", "country": "US" } },
  "rating": {
    "reviewCount": 34,
    "recommendedRate": 87,
    "averageOverallRating": 4.5,       // ROUNDED display value
    "averageRatings": {                // unrounded, per dimension
      "OVERALL": 4.65625, "QUALITY": 4.769, "VALUE": 4.423,
      "PUNCTUALITY": 4.807, "PROFESSIONALISM": 4.769, "RESPONSIVENESS": 4.846
    },
    "bestReview": { "reviewId": "…", "comment": "…", "createdOn": "2020-03-28T23:48:23Z" }
  },
  "tasksOffered": ["Faucets, Fixtures and Pipes - Repair or Replace", …],
  "awards": [...], "proSuppliedPhotos": [...]
}
```

`averageOverallRating` (4.5) and `averageRatings.OVERALL` (4.65625) genuinely
differ — the first is rounded for display. `compactProvider` exposes the
unrounded one as `rating` and the rounded one as `displayRating`.

## 2. Profile + reviews — `GET <profileUrl>`

Extraction key: **`reviewId`**. Two profile pages were captured: one carried
**48** reviews with every `categories` reference resolving to an array, the
other **50** reviews where `categories` was `null` on all of them. Both are
normal — treat `categories` as optional rather than inferring it from one page.

```jsonc
{
  "reviewId": "…",
  "rating": 5,                  // also seen as `starRating` on some pages
  "text": "…",
  "cost": 1500,                 // dollars, or absent
  "reportDate": "2026-04-22T00:35:02.769099",
  "userName": "…",
  "isAnonymous": false, "isVerified": true, "isGoogleReview": false,
  "source": "…", "leafSlug": "…",
  "categories": [ { "haId": 40111, "name": "Septic System Repair", "reviewCount": 1 } ],
  "serviceProviderId": 159707286, "serviceProviderUuid": "…", "serviceProviderName": "…",
  "spComment": "…",             // the pro's public response, when present
  "wouldHireAgain": true        // present on some reviews
}
```

The profile page also carries one provider record (`legacyId`), which
`angi_get_pro` reads.

## 3. Taxonomy — sitemaps (plain fetch, no bridge)

- `/sitemap/statecat-sitemap.xml` — 15,865 `<loc>` entries → **312 distinct
  trade slugs** via `/companylist/us/<st>/<trade>.htm`.
- `/sitemap/geo-sitemap-index.xml` → per-trade children
  `angi-geocat-<trade>.xml`, each listing every
  `/companylist/us/<st>/<city>/<trade>.htm`. Use to validate a city/trade
  combination before fetching.
- Also in `robots.txt`: `article-sitemap.xml`, `leaf-sitemap-index.xml`,
  `nearme-sitemap.xml`, `topic-sitemap.xml`.

## Verified negatives — do not build on these

- **`?zip=` is inert.** `…/us/nc/charlotte/plumbing.htm?zip=90210` returns the
  identical Charlotte providers as the unparameterised URL. Location is
  path-only; there is no zip filter to expose.
- **No XHR/JSON endpoint** backs search or pagination — `?page=N` is a full SSR
  page load.
- **JSON-LD lacks ratings and ids** (see above).

## 4. Signed-in account — `my.angi.com`

Captured 2026-08-10 against a real signed-in account.

**`my.angi.com` is a different application from `www.angi.com`.** It is Next.js
**Pages Router**, so its data is a plain `__NEXT_DATA__` JSON blob — *not* the
RSC flight rows `src/parse.ts` handles. Two extractors, one repo; don't cross
them. Auth is the session cookie, which is **HttpOnly** (absent from
`document.cookie`), so it cannot be read out of the browser — it simply rides
requests made from the tab. Signed-out requests are **redirected to
`/auth/login`**, not 401'd.

| Surface | Path | Mechanism | Verified |
| --- | --- | --- | --- |
| Projects | `GET my.angi.com/myprojects` | SSR `__NEXT_DATA__` | envelope only |
| Reviews written | `GET my.angi.com/account/rating-review/reviews` | JSON, cookie auth | envelope only |
| Reviews page | `my.angi.com/account/reviews` | client-rendered, **no SSR data** | n/a |
| Inbox | `my.angi.com/inbox` | **Twilio Conversations SDK** | not reachable |

### Projects — `/myprojects`

`props.pageProps.initialState` carries:

```jsonc
{
  "openProjectList":   { "projects": [], "pagination": null },
  "closedProjectList": { "projects": [], "pagination": null },
  "projectHomeUser": {
    "alUserId": 12345, "entityId": 67890, "entityHash": "…",
    "firstName": "…", "email": null, "unreadMessageCount": null,
    "userLocation": null, "sessionId": "…"
  },
  "projectDetails": { "isProjectClosed": false, "taskId": null, "taskDescription": null, "zipcode": null }
}
```

Plus ~22 RTK-Query slices (`getProjectsListApi`, `getProjectProsApi`,
`bookingResponsesApi`, `internalReviewsApi`, `postRequestQuoteApi`,
`jobStatusApi`, …) which hydrate client-side.

### Reviews written — `/account/rating-review/reviews`

Plain JSON, authenticated by the session cookie alone. Verified `200`:

```json
{"unratedPros":[],"reviews":[]}
```

### Inbox — not reachable by HTTP

The inbox is a **Twilio Conversations** client. The page mints a token at
`/api/resource/conversation-service-proxy/conversation/api/v1/me/platforms/TWILIO/token`
and then speaks the Twilio SDK protocol. Calling the proxy endpoints with the
session cookie alone returns **401** with an XML body
(`username or accesskey could not be verified`) — they need a separate access
credential. **Reading messages is therefore out of scope for an HTTP client**;
it would require embedding the Twilio SDK, not a GET.

### The verification limit — record shapes are UNKNOWN

The reference account holds **zero projects, zero reviews and zero messages**.
So every list above was observed **empty**: the envelopes are verified, the
per-record fields have never been seen.

`angi_list_my_projects` and `angi_list_my_reviews` therefore return records
**raw**, and set `recordFieldsVerified: false` in the response. No compact
projection exists for account records, deliberately — projecting onto invented
field names would be a guess dressed as data. When an account with real
projects is available, capture a populated record, add the shape here, and only
then add a projection.
