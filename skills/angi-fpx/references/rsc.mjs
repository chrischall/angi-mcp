// Angi RSC flight extractor — dependency-free, no npm deps.
//
// Angi is a Next.js App Router site. A page's real data is not in JSON-LD and
// not in a __NEXT_DATA__ blob: it arrives as React Server Component "flight"
// rows, delivered as JS string literals inside `self.__next_f.push([1,"..."])`.
// Concatenating the unescaped literals yields newline-separated rows of the
// form `<hexid>:<json>`. Values are deduplicated across rows, so a field can
// hold the reference `"$b5"` instead of its value — resolve() follows those.

/** Recover the concatenated flight text from a raw HTML document. */
export function flightText(html) {
  const re = /self\.__next_f\.push\(\[\d+\s*,\s*"((?:[^"\\]|\\.)*)"/g;
  let out = '';
  for (const m of html.matchAll(re)) {
    // A chunk that will not unescape is skipped rather than aborting the page.
    try { out += JSON.parse(`"${m[1]}"`); } catch { /* ignore */ }
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
 *  - JSON rows (`3:{...}` / `b5:[...]`), read to end of line.
 *  - Text chunks (`b6:T476,I am just blown away...`) — a raw string of the
 *    given UTF-8 BYTE length, which RSC uses for long strings such as review
 *    bodies. Not JSON: read by length, not parsed. They may contain newlines,
 *    which is why this scans positionally rather than splitting on newline.
 *
 * Missing the text-chunk form leaves the referring field holding a literal
 * "$57" that reads like data — verified against a live profile page where 4 of
 * 50 review bodies arrived this way.
 */
export function flightRows(text) {
  const rows = new Map();
  for (const m of text.matchAll(ROW_START)) {
    const id = m[1];
    const rest = text.slice(m.index + m[0].length);

    const t = TEXT_CHUNK.exec(rest);
    if (t) {
      const byteLen = Number.parseInt(t[1], 16);
      const from = rest.slice(t[0].length);
      // UTF-8 is >= 1 byte per char, so byteLen chars always covers byteLen
      // bytes; encode that window and cut it to the exact byte length.
      const bytes = new TextEncoder().encode(from.slice(0, byteLen));
      rows.set(id, new TextDecoder().decode(bytes.slice(0, byteLen)));
      continue;
    }

    const nl = rest.indexOf('\n');
    const line = nl === -1 ? rest : rest.slice(0, nl);
    // Rows like `I[...]`/`HL[...]` are module/preload directives, not data.
    if (!/^[[{"]/.test(line)) continue;
    try { rows.set(id, JSON.parse(line)); } catch { /* ignore */ }
  }
  return rows;
}

/**
 * Replace `"$<rowid>"` references with the referenced value, recursively.
 * `"$undefined"` becomes undefined; `"$$x"` is an escaped literal `"$x"`.
 * Guards against reference cycles and runaway depth.
 */
export function resolve(value, rows, seen = new Set(), depth = 0) {
  if (depth > 24) return value;
  if (typeof value === 'string') {
    if (value === '$undefined') return undefined;
    if (value.startsWith('$$')) return value.slice(1);
    if (/^\$[0-9a-f]+$/.test(value)) {
      const id = value.slice(1);
      if (seen.has(id) || !rows.has(id)) return value; // cycle / unknown: keep the token
      return resolve(rows.get(id), rows, new Set([...seen, id]), depth + 1);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, rows, seen, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolve(v, rows, seen, depth + 1);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return value;
}

/** Brace-match forward from `start`, which must index a '{' or '['. */
function matchSpan(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/**
 * Every JSON object in the flight text that owns `key` as a direct property,
 * with references resolved. Walks back from each hit to the nearest enclosing
 * '{' that parses and still contains the key. Undocumented payloads drift, so
 * a candidate that fails to parse is skipped rather than thrown.
 */
export function objectsWithKey(text, key, { limit = Infinity, resolveRefs = true } = {}) {
  const rows = resolveRefs ? flightRows(text) : null;
  const needle = `"${key}"`;
  const seen = new Set();
  const out = [];
  let from = 0;
  while (out.length < limit) {
    const hit = text.indexOf(needle, from);
    if (hit === -1) break;
    from = hit + needle.length;
    for (let i = hit; i >= 0 && hit - i < 200_000; i--) {
      if (text[i] !== '{') continue;
      const span = matchSpan(text, i);
      if (!span || i + span.length <= hit) continue; // does not enclose the hit
      let obj;
      try { obj = JSON.parse(span); } catch { continue; }
      if (!(key in obj)) continue;
      const id = `${i}:${span.length}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(rows ? resolve(obj, rows) : obj);
      }
      break;
    }
  }
  return out;
}

/** Convenience: pull records straight out of raw HTML. */
export function recordsFromHtml(html, key, opts) {
  return objectsWithKey(flightText(html), key, opts);
}

// ---------------------------------------------------------------------------
// CLI:  node rsc.mjs <key> [--limit N] [--dedupe <field>] [--raw]  < page.html
// Reads an Angi HTML page on stdin, writes a JSON array of matching records to
// stdout. `--dedupe id` is almost always wanted: a search page emits each
// provider twice (once for the sponsored slot, once for the list).
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const key = argv.find((a) => !a.startsWith('--'));
  if (!key) {
    console.error('usage: node rsc.mjs <key> [--limit N] [--dedupe <field>] [--raw] < page.html');
    process.exit(1);
  }
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const limit = flag('--limit') ? Number(flag('--limit')) : Infinity;
  const dedupe = flag('--dedupe');
  const resolveRefs = !argv.includes('--raw');

  // `… | jq length` or `… | head` closes stdout early; without this the write
  // below throws an unhandled EPIPE and dumps a stack trace over the results.
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  });

  let html = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) html += chunk;

  let recs = objectsWithKey(flightText(html), key, { limit, resolveRefs });
  if (dedupe) recs = [...new Map(recs.map((r) => [r[dedupe], r])).values()];
  process.stdout.write(JSON.stringify(recs, null, 2) + '\n');
}
