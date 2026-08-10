# angi-mcp

MCP server for [Angi](https://www.angi.com) (formerly Angie's List) — find
home-service pros by trade and city, and read their ratings, profiles and
reviews.

Angi serves its pages only to a real browser, so requests route through the
user's own `angi.com` tab via the [fetchproxy](https://github.com/chrischall/fetchproxy)
browser extension, reusing their existing session. The trade/city taxonomy is
read directly from Angi's public sitemaps and needs no browser at all.

**No Angi account or credentials are required.** Everything this server reads
is public.

> This project was developed and is maintained by AI (Claude). Use at your own
> discretion.

## Install

```sh
npm install -g @chrischall/angi-mcp
```

Register it with your MCP host:

```json
{
  "mcpServers": {
    "angi": { "command": "angi-mcp" }
  }
}
```

You also need the fetchproxy **Transporter** browser extension, with an open
`angi.com` tab and its site access allowing `angi.com`. On the first request
the extension shows a pairing code to approve; the trust then persists.

Run `angi_healthcheck` to confirm the bridge is connected.

## Tools

| Tool | What it does |
| --- | --- |
| `angi_search_pros` | Pros for a trade in a US city, with ratings, review counts, years in business, service area, amenities. 10 per page. |
| `angi_get_pro` | One pro's full profile and ratings breakdown. |
| `angi_get_reviews` | Reviews on a pro's profile — rating, text, reported cost, date, categories, the pro's response. Filterable by rating. |
| `angi_list_trades` | Every trade slug Angi publishes (~312). No bridge needed. |
| `angi_list_cities` | Cities Angi publishes pages for, per trade. No bridge needed. |
| `angi_healthcheck` | Bridge connection state. |

Signed-in tools (need the browser tab signed in to Angi):

| Tool | What it does |
| --- | --- |
| `angi_get_account` | Your identity and open/closed project counts. |
| `angi_list_my_projects` | Your Angi projects, open and closed. |
| `angi_list_my_reviews` | Reviews you've written, plus pros awaiting a rating. |

Searches take **slugs**, not free text — resolve them first:

```
angi_list_trades   { contains: "duct" }      -> "air-duct-cleaning"
angi_list_cities   { trade: "plumbing", state: "nc", contains: "char" }
angi_search_pros   { trade: "plumbing", state: "nc", city: "charlotte", compact: true }
```

Pass `compact: true` when browsing or ranking — it projects each record to a
slim summary instead of the full ~1KB payload.

### Ratings

Each pro carries two overall ratings and they differ on purpose:

- `rating` (`averageRatings.OVERALL`) — unrounded. **Rank on this.**
- `displayRating` (`averageOverallRating`) — the rounded value Angi shows.

Per-dimension ratings (quality, value, punctuality, professionalism,
responsiveness) come through in the full record.

`isSponsored: true` marks paid placement, not a quality signal.

## Limits

- **No zip-code filtering.** Angi's `?zip=` parameter is inert — a Charlotte URL
  returns Charlotte pros regardless. Location comes from the city slug.
- **Account record shapes are unverified.** The account used to map
  `my.angi.com` held zero projects and zero reviews, so only the *envelopes*
  were observed. `angi_list_my_projects` and `angi_list_my_reviews` return
  records raw and set `recordFieldsVerified: false` rather than projecting onto
  field names nobody has seen. See `docs/ANGI-API.md`.
- **The inbox is not readable.** Angi's messages run on the Twilio
  Conversations SDK; the proxy endpoints reject the session cookie alone (401),
  so messages need the Twilio client rather than an HTTP GET.
- **Cannot be hosted remotely.** Like every browser-bridge server in this fleet,
  it needs a signed-in tab on the machine it runs on, so it cannot be served to
  claude.ai from mcp-host.

## Without the MCP

`skills/angi-fpx/` is a shell-out skill that reads the same data with the `fpx`
CLI and no running server — useful in scripts or on a machine where the MCP
isn't installed.

## Development

```sh
npm install
npm run build      # tsc --noEmit + esbuild bundle
npm test
```

`docs/ANGI-API.md` records the live-captured request/response shapes, including
the verified negative results. Read it before changing `src/parse.ts`.

## License

MIT
