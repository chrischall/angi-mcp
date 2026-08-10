import { matchBalanced } from '@chrischall/mcp-utils/scrape';

// React Server Component "flight" payload extraction for angi.com.
//
// Angi is a Next.js App Router site and publishes no consumer API: its search
// pages issue zero XHR. A page's records are neither in the rendered HTML nor
// in a `__NEXT_DATA__` blob — they arrive as flight rows delivered as JS string
// literals inside `self.__next_f.push([1,"…"])`. Concatenating the unescaped
// literals yields newline-separated rows of the form `<hexid>:<json>`, and
// nested values are deduplicated across rows, so a field can hold the reference
// `"$b5"` instead of its value (references chain: `b5:["$b6"]`).
//
// Verified against live angi.com bytes: a Charlotte/plumbing search page yields
// 20 provider records (10 unique — see dedupeById) and a pro profile page 48
// review records, with every reference resolved.

/** Recover the concatenated flight text from a raw HTML document. */
export function flightText(html: string): string {
  const re = /self\.__next_f\.push\(\[\d+\s*,\s*"((?:[^"\\]|\\.)*)"/g;
  let out = '';
  for (const m of html.matchAll(re)) {
    // A chunk that will not unescape is skipped rather than aborting the page.
    try {
      out += JSON.parse(`"${m[1]}"`) as string;
    } catch {
      /* ignore malformed chunk */
    }
  }
  return out;
}

const ROW_START = /(?:^|\n)([0-9a-f]+):/g;
/** `T<hexByteLength>,` marks a raw text chunk rather than a JSON row. */
const TEXT_CHUNK = /^T([0-9a-f]+),/;

/**
 * Map of rowId -> value, for every row that carries data.
 *
 * Two row encodings matter:
 *  - JSON rows (`3:{…}` / `b5:[…]`), read to end of line.
 *  - **Text chunks** (`b6:T476,I am just blown away…`) — a raw string of the
 *    given UTF-8 **byte** length, which RSC uses for long strings such as
 *    review bodies. These are not JSON and must be read by length, not parsed;
 *    they may also contain newlines, which is why this scans positionally
 *    instead of splitting on '\n'.
 *
 * Missing the text-chunk form is not cosmetic: it leaves the referring field
 * holding a literal `"$57"` that reads like data. Verified against a live
 * profile page where 4 of 50 review bodies arrived this way.
 */
export function flightRows(text: string): Map<string, unknown> {
  const rows = new Map<string, unknown>();
  ROW_START.lastIndex = 0;
  for (const m of text.matchAll(ROW_START)) {
    const id = m[1];
    const bodyStart = m.index! + m[0].length;
    const rest = text.slice(bodyStart);

    const t = TEXT_CHUNK.exec(rest);
    if (t) {
      const byteLen = Number.parseInt(t[1], 16);
      const from = rest.slice(t[0].length);
      // UTF-8 uses >= 1 byte per char, so byteLen chars is always enough to
      // cover byteLen bytes; encode that window and cut it to the exact length.
      const bytes = new TextEncoder().encode(from.slice(0, byteLen));
      rows.set(id, new TextDecoder().decode(bytes.slice(0, byteLen)));
      continue;
    }

    const line = rest.slice(0, rest.indexOf('\n') === -1 ? undefined : rest.indexOf('\n'));
    // Rows like `I[…]` / `HL[…]` are module and preload directives, not data.
    if (!/^[[{"]/.test(line)) continue;
    try {
      rows.set(id, JSON.parse(line));
    } catch {
      /* ignore non-JSON row */
    }
  }
  return rows;
}

const MAX_DEPTH = 24;

/**
 * Replace `"$<rowid>"` references with the referenced value, recursively.
 * `"$undefined"` becomes undefined; `"$$x"` is an escaped literal `"$x"`.
 * A reference cycle or an unknown row leaves the token in place rather than
 * throwing — undocumented payloads drift, so degrade instead of breaking.
 */
export function resolveRefs(
  value: unknown,
  rows: Map<string, unknown>,
  seen: ReadonlySet<string> = new Set(),
  depth = 0
): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') {
    if (value === '$undefined') return undefined;
    if (value.startsWith('$$')) return value.slice(1);
    if (/^\$[0-9a-f]+$/.test(value)) {
      const id = value.slice(1);
      if (seen.has(id) || !rows.has(id)) return value;
      return resolveRefs(rows.get(id), rows, new Set([...seen, id]), depth + 1);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveRefs(v, rows, seen, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveRefs(v, rows, seen, depth + 1);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return value;
}

/** Brace-match forward from `start`, which must index a '{' or '['. */
function matchSpan(s: string, start: number): string | null {
  // matchBalanced returns the exclusive end index, or -1 if `start` is not on
  // an opener or the structure never closes.
  const end = matchBalanced(s, start);
  return end === -1 ? null : s.slice(start, end);
}

/** How far back from a key hit we will look for the enclosing object. */
const MAX_LOOKBACK = 200_000;

export interface ObjectsWithKeyOptions {
  limit?: number;
  /** Set false to keep `"$…"` reference tokens verbatim (debugging). */
  resolve?: boolean;
}

/**
 * Every JSON object in the flight text that owns `key` as a direct property,
 * with references resolved. Walks back from each hit to the nearest enclosing
 * '{' that parses and still contains the key; a candidate that fails to parse
 * is skipped rather than thrown.
 */
export function objectsWithKey(
  text: string,
  key: string,
  { limit = Infinity, resolve = true }: ObjectsWithKeyOptions = {}
): Record<string, unknown>[] {
  const rows = resolve ? flightRows(text) : null;
  const needle = `"${key}"`;
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  let from = 0;
  while (out.length < limit) {
    const hit = text.indexOf(needle, from);
    if (hit === -1) break;
    from = hit + needle.length;
    for (let i = hit; i >= 0 && hit - i < MAX_LOOKBACK; i--) {
      if (text[i] !== '{') continue;
      const span = matchSpan(text, i);
      if (!span || i + span.length <= hit) continue; // does not enclose the hit
      let obj: unknown;
      try {
        obj = JSON.parse(span);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object' || !(key in obj)) continue;
      const id = `${i}:${span.length}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(
          (rows ? resolveRefs(obj, rows) : obj) as Record<string, unknown>
        );
      }
      break;
    }
  }
  return out;
}

/** Convenience: pull records straight out of a raw HTML page. */
export function recordsFromHtml(
  html: string,
  key: string,
  opts?: ObjectsWithKeyOptions
): Record<string, unknown>[] {
  return objectsWithKey(flightText(html), key, opts);
}

/**
 * A search page emits each provider twice — once for the sponsored slot and
 * once for the list row — so callers must dedupe on the stable uuid.
 */
export function dedupeById<T extends { id?: unknown }>(items: T[]): T[] {
  const byId = new Map<unknown, T>();
  const out: T[] = [];
  for (const item of items) {
    if (item.id === undefined) {
      out.push(item);
      continue;
    }
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
      out.push(item);
    }
  }
  return out;
}
