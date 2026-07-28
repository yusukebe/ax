import { readFile, stat } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { parseArgs, num } from '../lib/args'
import { toArray, toStrings, nodeId, type DomNode } from '../lib/dom'
import type { FlagValue } from '../lib/args'
import type { ReadSourceOptions } from '../lib/io'
import {
  readSource,
  readStdinBytes,
  readStdinText,
  fail,
  guardsFromFlags,
  readBodyCapped,
  readWithDeadline,
  timeoutError,
  decodeBody,
  type CappedBody,
} from '../lib/io'
import { emitLines, emitJson, emitJsonEnvelope, writeStdoutFlushed } from '../lib/emit'
import { compileWhere } from '../lib/expr'
import { toTsv } from '../lib/tsv'

export const rootHelp = `ax — the AI-era curl: fetch, discover, extract. One command.

usage:
  ax <url|file|-> [selector] [options]

fetch (no selector — curl parity, but never silent):
  ax https://api.example.com/users        {status, ok, url, redirected, ms, headers, body}
  -X, --method <m>   -H, --header <k: v>   -d, --data <body|@file|@->
  curl reflexes work: -u user:pass  -I (HEAD)  -o <file>  -k  -m <secs>
  -f (HTTP errors -> exit 22, report still printed; with -o the error body
      is never saved and the file at -o keeps whatever it had before)
  --data-raw <literal> (never reads @ as a file)  --data-binary <body|@file>
  (-d strips CR/LF from @file contents, curl-style; --data-binary keeps them)
  -L -i -s -S --compressed are accepted no-ops
  --body             body only on stdout, uncapped (redirect/status notes on stderr)
  JSON bodies are parsed; fetch mode never caches — every request is live
  noisy response headers are omitted (announced; --headers shows all)
  downloads stop at 20MB / 30s by default (--max-bytes <n>, -m <secs>; capped
  reads are always announced, never silent)

discover (unknown page? never dump raw HTML):
  --outline          repeating tag.class signatures with counts
  --locate <text>    which selector holds this text (matches attributes too)
  --count            how many elements match <selector>
  parse-mode URLs are cached ~2min so probing is free (hits announced;
  --fresh = refetch then re-cache, --no-cache = never touch the disk;
  Cache-Control: no-store, credential-bearing URLs, requests with -H/-u,
  and non-GET/-d requests are never cached; -k may read the cache but
  never writes it)

extract (selector — CSS, structured):
  --row 'title=a, href=a@href, level=.cefr'   structured rows (@attr reads
                                              attributes; empty sel = the match)
  --table            <table> → rows keyed by headers
  --text | --attr <name> | --html             simpler per-match output
  --md               readable page content as markdown (for reading docs;
                     capped at ~2000 tokens unless --all or --budget T)
  --where <expr>     filter rows: price > 100 && name ~ /^foo/i  (no eval;
                     \`col name\` for headers with spaces)

output shape (token-cheap by design):
  rows default to TSV (header once, ≈40% of JSON tokens); --json for JSON rows
  --json-envelope    {data, meta}; continue only while state=more → --offset next_offset
                     stop on complete or past_end; do not restart or increase budget
  --limit <n> (default 50)   --all
  --budget <t>       cap output at ~t tokens; truncation is never silent
  --offset <n>       skip the first n results — truncation notes name the
                     exact --offset to continue from, and the URL cache makes
                     the follow-up free (no refetch, no re-read overlap)

examples:
  ax https://site.example '.item > a' --row 'title=, href=@href'
  ax https://site.example '.private' -H 'authorization: Bearer x' --text
  ax https://site.example --outline
  ax https://docs.site.example/guide --md --budget 800
  ax page.html 'table.stats' --table --where 'Stars >= 30000'
  ax https://api.site.example/things -H 'authorization: Bearer x'`

// num()'s constraint slot needs an exact (message: string) => never shape;
// fail's optional `hint` keeps the function itself from flowing as a value.
const failWith = (message: string): never => fail(message)

type Field = { name: string; sel: string; attr: string | null }

function parseRowSpec(spec: string): Field[] {
  return spec
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf('=')
      if (eq === -1) fail(`bad --row field (expected name=selector): ${part}`)
      const name = part.slice(0, eq).trim()
      let sel = part.slice(eq + 1).trim()
      let attr: string | null = null
      const at = sel.indexOf('@')
      if (at !== -1) {
        attr = sel.slice(at + 1).trim()
        sel = sel.slice(0, at).trim()
      }
      if (!name) fail(`bad --row field (missing name): ${part}`)
      return { name, sel, attr }
    })
}

// Fetch-report headers an agent acts on; the rest are noise (--headers shows all).
const KEEP_HEADERS = new Set([
  'content-type',
  'content-length',
  'location',
  'retry-after',
  'www-authenticate',
  'cache-control',
  'etag',
  'last-modified',
])

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ')

function requestHeaders(flags: Record<string, FlagValue>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const h of (flags.header ?? []) as string[]) {
    const idx = h.indexOf(':')
    if (idx === -1) fail(`bad header (expected 'Name: value'): ${h}`)
    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim()
  }
  if (typeof flags.user === 'string') {
    headers['authorization'] = 'Basic ' + Buffer.from(flags.user).toString('base64')
  }
  return headers
}

// User-supplied selectors reach css-what/linkedom, which throw plain Errors
// (with node_modules stack traces) on malformed CSS — never let those leak
// past the fail() contract of a structured, single-line stderr message.
function query1(root: DomNode, sel: string): DomNode | null {
  try {
    return root.querySelector(sel)
  } catch (e) {
    fail(`bad selector: ${sel} (${(e as Error).message})`)
  }
}

function queryAll(root: DomNode, sel: string): DomNode[] {
  try {
    return toArray(root.querySelectorAll(sel))
  } catch (e) {
    fail(`bad selector: ${sel} (${(e as Error).message})`)
  }
}

function escapeCssIdentifier(value: string): string {
  let result = ''
  const first = value.charCodeAt(0)

  if (value.length === 1 && first === 45) return '\\-'

  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 0) {
      result += '\uFFFD'
    } else if (
      (code >= 1 && code <= 31) ||
      code === 127 ||
      (index === 0 && code >= 48 && code <= 57) ||
      (index === 1 && code >= 48 && code <= 57 && first === 45)
    ) {
      result += `\\${code.toString(16)} `
    } else if (
      code >= 128 ||
      code === 45 ||
      code === 95 ||
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122)
    ) {
      result += value.charAt(index)
    } else {
      result += `\\${value.charAt(index)}`
    }
  }

  return result
}

function signature(el: DomNode): string {
  const classes = toStrings(el.classList).map(escapeCssIdentifier)
  return (el.localName as string) + (classes.length ? '.' + classes.join('.') : '')
}

function selectorPath(el: DomNode): string {
  // Collected leaf-first and reversed at the end: unshift has no lowering.
  const parts: string[] = []
  let node: DomNode | null = el
  while (node && node.localName !== 'body' && node.localName !== 'html') {
    parts.push(
      node.id
        ? `${node.localName as string}#${escapeCssIdentifier(node.id as string)}`
        : signature(node)
    )
    node = node.parentElement
  }
  const ordered: string[] = []
  for (let i = parts.length - 1; i >= 0; i--) ordered.push(parts[i]!)
  return ordered.join(' > ')
}

// Tag semantics for --md, built from disjoint tiers: each tag is listed
// exactly once, and the subset relations (zero-footprint ⊂ invisible ⊂
// skip, structured ⊂ block) hold by construction.

// display:none in a real browser — dropped without leaving a gap on
// screen, so no separating space either.
const ZERO_FOOTPRINT_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'head',
  'title',
  'datalist',
  'option',
])
// Occupy space on screen but render no text usable as content or a link
// label: replaced/embedded content, plus form fields whose text (option
// lists, typed values) never reads as prose. Dropping one leaves a space.
const REPLACED_TAGS = new Set([
  'svg',
  'select',
  'textarea',
  'video',
  'audio',
  'object',
  'canvas',
  'iframe',
])
// Page chrome and widgets whose text is visible on screen but isn't
// content: dropped from flowing prose, still usable as a link's label.
const WIDGET_TAGS = new Set(['nav', 'header', 'footer', 'aside', 'form', 'button'])

// Never renders visible text in a browser — excluded from link-label rescue.
const INVISIBLE_TAGS = new Set([...ZERO_FOOTPRINT_TAGS, ...REPLACED_TAGS])
// Elements whose text (and descendants) never belong in readable output.
const SKIP_TAGS = new Set([...INVISIBLE_TAGS, ...WIDGET_TAGS])

// Structure markdown can't express inside a link label. A block-promoted
// <a href> wrapping none of these flattens to [text](url) so the href
// survives; one wrapping any of them recurses as blocks instead, trading
// the href for the structure.
const STRUCTURED_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'table',
  'blockquote',
  'ul',
  'ol',
  'dl',
])
// Block-level elements per HTML's default display; everything else —
// including unknown/custom tags — defaults to inline, matching browsers.
const BLOCK_TAGS = new Set([
  ...STRUCTURED_TAGS,
  'p',
  'li',
  'div',
  'dt',
  'dd',
  'section',
  'article',
  'main',
  'figure',
  'figcaption',
  'details',
  'summary',
  'dialog',
  'fieldset',
  'hr',
  'address',
  'hgroup',
  'menu',
  'center',
])

// Exported for the tag-tier invariant test.
export const MD_TAG_TIERS = {
  zeroFootprint: ZERO_FOOTPRINT_TAGS,
  replaced: REPLACED_TAGS,
  widget: WIDGET_TAGS,
  structured: STRUCTURED_TAGS,
  block: BLOCK_TAGS,
}

// Does el contain a descendant whose tag is in `tags`? SKIP_TAGS subtrees
// are pruned so hidden markup (a <p> inside <noscript>, form internals)
// can't affect the answer; the optional memo keeps the overall walk linear
// on deeply nested markup.
function hasDescendantIn(el: DomNode, tags: Set<string>): boolean {
  for (const child of el.children) {
    if (SKIP_TAGS.has(child.localName as string)) continue
    if (tags.has(child.localName as string) || hasDescendantIn(child, tags)) return true
  }
  return false
}

// Same walk, memoized. Split from the plain form because an optional Map
// parameter is a union with no runtime narrowing test, and keyed by nodeId
// because scriptc's Map takes only string and number keys (weak collections
// are unavailable outright).
function hasDescendantInMemo(el: DomNode, tags: Set<string>, cache: Map<number, boolean>): boolean {
  const key = nodeId(el)
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  let found = false
  for (const child of el.children) {
    if (SKIP_TAGS.has(child.localName as string)) continue
    if (tags.has(child.localName as string) || hasDescendantInMemo(child, tags, cache)) {
      found = true
      break
    }
  }
  cache.set(key, found)
  return found
}

const blockDescendantCache = new Map<number, boolean>()
const hasBlockDescendant = (el: DomNode) =>
  hasDescendantInMemo(el, BLOCK_TAGS, blockDescendantCache)

const hasStructuredContent = (el: DomNode) => hasDescendantIn(el, STRUCTURED_TAGS)

// Text a browser would actually show for el — used to rescue a link label
// when the normal skip leaves nothing (e.g. <a><button>Buy</button></a>).
function visibleText(el: DomNode): string {
  let out = ''
  for (const child of el.childNodes) {
    if (child.nodeType === 3) out += child.data as string
    if (child.nodeType !== 1) continue
    const ce: DomNode = child
    const tag = ce.localName as string
    if (tag === 'br') {
      out += ' '
    } else if (tag === 'svg') {
      // An icon's accessible name (<svg><title>) is the label a screen
      // reader announces — use it before giving up on the link text.
      out += ((ce.querySelector('title')?.textContent as string | null) ?? '') || ' '
    } else if (INVISIBLE_TAGS.has(tag)) {
      if (!ZERO_FOOTPRINT_TAGS.has(tag)) out += ' '
    } else {
      out += tag === 'img' ? ((ce.getAttribute('alt') as string | null) ?? '') : visibleText(ce)
    }
  }
  return out
}

// A link's markdown label: its inline rendering, or — when the normal skip
// leaves nothing — any text a browser would actually show (button labels,
// svg titles, img alt).
const linkLabel = (el: DomNode) => collapse(inlineToMd(el)) || collapse(visibleText(el))

// Text of a <pre> with SKIP_TAGS subtrees pruned but whitespace preserved —
// textContent would leak <script>/<style> source into the code fence.
function rawText(el: DomNode): string {
  let out = ''
  for (const child of el.childNodes) {
    if (child.nodeType === 3) out += child.data as string
    else if (child.nodeType === 1 && !SKIP_TAGS.has(child.localName as string))
      out += rawText(child)
  }
  return out
}

// HTML table model, shared by --md and --table: rows and cells nested in an
// inner table belong to that table, not the one being read.
const directRows = (table: DomNode) =>
  toArray(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table)
const directCells = (tr: DomNode) =>
  toArray(tr.children).filter((c) => c.localName === 'th' || c.localName === 'td')

// --md: readable main content as markdown — the docs-reading path.
// Convert a single inline-context node to markdown, turning <a> into
// [text](url) and skipping SKIP_TAGS content wherever it appears.
function inlineNodeToMd(node: DomNode): string {
  if (node.nodeType === 3) return node.data as string
  if (node.nodeType !== 1) return ''
  const el: DomNode = node
  const tag = el.localName as string
  // A dropped widget still separates the words around it on screen
  // (Press<button>OK</button>to continue), so it becomes a space, which
  // collapse() later folds into the surrounding whitespace.
  if (SKIP_TAGS.has(tag)) return ZERO_FOOTPRINT_TAGS.has(tag) ? '' : ' '
  if (tag === 'a') {
    const raw = inlineToMd(el)
    const label = linkLabel(el)
    const href = (el.getAttribute('href') as string | null) ?? ''
    // No label anywhere (icon-only link with no alt/title): emit the raw
    // inline text rather than [](url) litter, matching the block branch.
    if (!href || !label) return raw
    // Boundary whitespace stays outside the brackets so a label like
    // "the guide " doesn't glue the link to the following word.
    const lead = /^\s/.test(raw) ? ' ' : ''
    const trail = /\s$/.test(raw) ? ' ' : ''
    return `${lead}[${label}](${href})${trail}`
  }
  if (tag === 'br') return ' '
  if (tag === 'img') {
    const alt = (el.getAttribute('alt') as string | null) ?? ''
    const src = (el.getAttribute('src') as string | null) ?? ''
    return alt && src && !src.startsWith('data:') ? `![${alt}](${src})` : alt
  }
  // Pad block-level children so adjacent blocks rendered in an inline
  // context (<td><p>a</p><p>b</p></td>, nested table cells) don't fuse
  // into one word.
  const inner = inlineToMd(el)
  const isBlockish =
    BLOCK_TAGS.has(tag) || ['tr', 'td', 'th', 'caption', 'thead', 'tbody', 'tfoot'].includes(tag)
  return isBlockish ? ` ${inner} ` : inner
}

function inlineToMd(el: DomNode): string {
  let out = ''
  for (const child of el.childNodes) out += inlineNodeToMd(child)
  return out
}

function toMarkdown(root: DomNode): string {
  const out: string[] = []
  const walk = (el: DomNode) => {
    let inline = ''
    const flush = () => {
      const text = collapse(inline)
      if (text) out.push(text)
      inline = ''
    }
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        inline += child.data as string
        continue
      }
      if (child.nodeType !== 1) continue
      const ce: DomNode = child
      const tag = ce.localName as string
      if (SKIP_TAGS.has(tag)) {
        if (!ZERO_FOOTPRINT_TAGS.has(tag)) inline += ' '
        continue
      }
      // Inline elements join the surrounding text run — unless they contain
      // a block-level descendant, in which case they're walked as blocks so
      // nested headings/paragraphs don't get fused into one line.
      if (!BLOCK_TAGS.has(tag) && !hasBlockDescendant(ce)) {
        inline += inlineNodeToMd(ce)
        continue
      }
      flush()
      if (/^h[1-6]$/.test(tag) || tag === 'p' || tag === 'li' || tag === 'blockquote') {
        const text = collapse(inlineToMd(ce))
        if (/^h[1-6]$/.test(tag) && text) {
          out.push(`${'#'.repeat(Number(tag.charAt(1)))} ${text}`)
        } else if (tag === 'p' && text) {
          out.push(text)
        } else if (tag === 'li' && text) {
          out.push(`- ${text}`)
        } else if (tag === 'blockquote' && text) {
          out.push(`> ${text}`)
        } else {
          walk(ce)
        }
      } else if (tag === 'pre') {
        out.push('```\n' + rawText(ce).trim() + '\n```')
      } else if (tag === 'table') {
        let caption: DomNode | null = null
        for (const c of toArray(ce.children)) {
          if (c.localName === 'caption') {
            caption = c
            break
          }
        }
        const capText = caption ? collapse(inlineToMd(caption)) : ''
        if (capText) out.push(capText)
        const table = directRows(ce)
          .map((tr) => directCells(tr).map((c) => collapse(inlineToMd(c))))
          .filter((cells) => cells.some((c) => c !== ''))
          .map((cells) => cells.join(' | '))
          .join('\n')
        if (table) out.push(table)
      } else if (tag === 'a' && ce.getAttribute('href') && !hasStructuredContent(ce)) {
        // A styled block link (<a href><div>Download</div></a>): flatten to
        // [text](url) so the href isn't silently lost. Links wrapping
        // structured content still recurse below.
        const text = linkLabel(ce)
        if (text) out.push(`[${text}](${ce.getAttribute('href') as string})`)
        else walk(ce)
      } else {
        walk(ce)
      }
    }
    flush()
  }
  const main =
    root.querySelector('article') ??
    root.querySelector('main') ??
    root.querySelector('body') ??
    root
  walk(main)
  return out.join('\n\n')
}

// curl semantics for the data flags: -d/--data and --data-binary treat a
// leading @ as "read this file" (@- means stdin); --data-raw never does —
// that's its entire reason to exist. -d additionally strips CR/LF from file
// contents (curl's documented --data behavior); --data-binary preserves them.
async function readDataFile(ref: string, binary = false): Promise<string | Uint8Array> {
  if (ref === '-') {
    return binary ? readStdinBytes() : readStdinText()
  }
  if (ref === '') {
    fail(`couldn't read data from file ""`, '--data-raw sends the literal string')
  }
  const exists = (await stat(ref).catch(() => null)) !== null
  if (!exists) {
    fail(`couldn't read data from file "${ref}"`, '--data-raw sends the literal string')
  }
  try {
    return binary ? new Uint8Array(await readFile(ref)) : await readFile(ref, 'utf8')
  } catch (e) {
    fail(
      `couldn't read data from file "${ref}": ${(e as Error).message}`,
      '--data-raw sends the literal string'
    )
  }
}

async function readDataArg(value: string, stripNewlines: boolean): Promise<string | Uint8Array> {
  if (!value.startsWith('@')) return value
  const data = await readDataFile(value.slice(1), !stripNewlines)
  return stripNewlines && typeof data === 'string' ? data.replace(/[\r\n]/g, '') : data
}

// -d wins over --data-raw wins over --data-binary when more than one is
// given, matching the precedence of the old .find([data, raw, binary]).
async function resolveData(
  flags: Record<string, FlagValue>
): Promise<string | Uint8Array | undefined> {
  if (typeof flags.data === 'string') return await readDataArg(flags.data, true)
  if (typeof flags['data-raw'] === 'string') return flags['data-raw']
  if (typeof flags['data-binary'] === 'string')
    return await readDataArg(flags['data-binary'], false)
  return undefined
}

// The curl-parity request bits (-X/-d/-k) shared by fetch mode and parse
// mode: resolve the body, fill in a default content-type when a body has
// none, infer the method, and translate -k into Bun's fetch tls option.
// Mutates headers in place (matching resolveData's existing call site).
async function curlRequestInit(
  flags: Record<string, FlagValue>,
  headers: Record<string, string>
): Promise<{
  method: string
  body: string | Uint8Array | undefined
  tls: { rejectUnauthorized: boolean } | undefined
}> {
  const body = await resolveData(flags)
  if (
    body !== undefined &&
    !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
  ) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
  }
  const method =
    typeof flags.method === 'string'
      ? flags.method.toUpperCase()
      : flags.head === true
        ? 'HEAD'
        : body !== undefined
          ? 'POST'
          : 'GET'
  // fetch() forbids a body on GET/HEAD — fail with a structured error instead
  // of letting Bun's TypeError leak a raw stack trace to the agent. The hint
  // names the flag the user actually typed (-I also implies HEAD).
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
    const culprit = typeof flags.method === 'string' ? `-X ${method}` : '-I'
    fail(
      `-d cannot be sent with ${method}`,
      `fetch() forbids GET/HEAD bodies; drop ${culprit} or use -X POST`
    )
  }
  return {
    method,
    body,
    tls: flags.insecure === true ? { rejectUnauthorized: false } : undefined,
  }
}

function isJsonContentType(value: string | null): boolean {
  const mediaType = ((value ?? '').split(';')[0] ?? '').trim().toLowerCase()
  const slash = mediaType.indexOf('/')
  if (slash === -1) return false
  const subtype = mediaType.slice(slash + 1)
  return subtype === 'json' || subtype.endsWith('+json')
}

export async function root(argv: string[]) {
  const { _, flags } = parseArgs(argv, {
    help: { type: 'boolean' },
    fresh: { type: 'boolean' },
    'no-cache': { type: 'boolean' },
    headers: { type: 'boolean' },
    all: { type: 'boolean' },
    text: { type: 'boolean' },
    html: { type: 'boolean' },
    json: { type: 'boolean' },
    'json-envelope': { type: 'boolean' },
    outline: { type: 'boolean' },
    count: { type: 'boolean' },
    table: { type: 'boolean' },
    tsv: { type: 'boolean' },
    md: { type: 'boolean' },
    attr: { type: 'string' },
    row: { type: 'string' },
    locate: { type: 'string' },
    where: { type: 'string' },
    limit: { type: 'string' },
    offset: { type: 'string' },
    budget: { type: 'string' },
    method: { type: 'string', short: 'X' },
    header: { type: 'string', short: 'H', multiple: true },
    data: { type: 'string', short: 'd' },
    // curl reflexes — an agent typing curl habits gets curl behavior:
    user: { type: 'string', short: 'u' },
    head: { type: 'boolean', short: 'I' },
    output: { type: 'string', short: 'o' },
    insecure: { type: 'boolean', short: 'k' },
    'max-time': { type: 'string', short: 'm' },
    'max-bytes': { type: 'string' },
    'data-raw': { type: 'string' },
    'data-binary': { type: 'string' },
    fail: { type: 'boolean', short: 'f' },
    body: { type: 'boolean' },
    // accepted no-ops (ax always behaves this way):
    location: { type: 'boolean', short: 'L' },
    include: { type: 'boolean', short: 'i' },
    silent: { type: 'boolean', short: 's' },
    'show-error': { type: 'boolean', short: 'S' },
    compressed: { type: 'boolean' },
  })
  if (flags.help || _.length === 0) return console.log(rootHelp)

  const src = _[0]
  const selector = _.length > 1 ? _[1] : undefined
  const opts = {
    limit: num(flags.limit, 50, { flag: '--limit', kind: 'positive integer', fail: failWith }),
    all: flags.all === true,
    budget: num(flags.budget, 0, { flag: '--budget', kind: 'positive integer', fail: failWith }),
    offset: num(flags.offset, 0, {
      flag: '--offset',
      kind: 'non-negative integer',
      fail: failWith,
    }),
  }
  const envelopeModifiers: [string, FlagValue][] = [
    ['--attr', flags.attr],
    ['--row', flags.row],
    ['--locate', flags.locate],
    ['--where', flags.where],
  ]
  const jsonEnvelope = flags['json-envelope'] === true
  const optionsEnd = argv.indexOf('--')
  const missingEnvelopeValue =
    (jsonEnvelope ? envelopeModifiers.find(([, value]) => value === true)?.[0] : undefined) ??
    envelopeModifiers.find(([flag]) =>
      argv.some(
        (arg, index) =>
          (optionsEnd === -1 || index < optionsEnd) &&
          arg === '--json-envelope' &&
          index > 0 &&
          argv[index - 1] === flag
      )
    )?.[0]
  if (missingEnvelopeValue) {
    fail(
      `${missingEnvelopeValue} requires a value`,
      'pass the modifier value before --json-envelope'
    )
  }
  // Spelled as statements, not a ternary: a ternary over two void calls trips
  // an internal compiler error in scriptc 0.0.17 (SC9001).
  const emitStructured = (value: unknown[]) => {
    if (jsonEnvelope) emitJsonEnvelope(value, opts)
    else emitJson(value, opts)
  }
  const isUrl = /^https?:\/\//.test(src!)
  const envelopeConflict =
    flags.md === true
      ? '--md'
      : flags.outline === true
        ? '--outline'
        : flags.count === true
          ? '--count'
          : flags.text === true
            ? '--text'
            : flags.html === true
              ? '--html'
              : typeof flags.attr === 'string'
                ? '--attr'
                : flags.body === true
                  ? '--body'
                  : null
  if (jsonEnvelope && envelopeConflict) {
    const hint =
      envelopeConflict === '--md'
        ? 'markdown continuation is not supported because an offset may split document structure'
        : 'use --row, --table, --locate, or selector JSON output'
    fail(`--json-envelope cannot be combined with ${envelopeConflict}`, hint)
  }
  const hasEnvelopeOutput =
    selector !== undefined || flags.table === true || typeof flags.locate === 'string'
  if (jsonEnvelope && !hasEnvelopeOutput) {
    fail(
      '--json-envelope requires structured parse output',
      'use it with --row, --table, --locate, or a selector; fetch mode already returns JSON'
    )
  }
  const headers = isUrl ? requestHeaders(flags) : {}
  const parseFlags =
    selector !== undefined ||
    flags.outline === true ||
    flags.md === true ||
    typeof flags.locate === 'string' ||
    flags.table === true

  // --- fetch mode: curl parity, structured, never silent ---
  if (isUrl && !parseFlags) {
    const { method, body: data, tls } = await curlRequestInit(flags, headers)
    const guards = guardsFromFlags(flags)
    const deadline = Date.now() + guards.timeoutMs
    const started = performance.now()
    // Untyped for the same two reasons as in readSource: `tls` is outside the
    // standard RequestInit, and the response's streaming surface is only
    // reachable through a dynamic value.
    const init: any = {
      method,
      headers,
      body: data,
      signal: AbortSignal.timeout(guards.timeoutMs),
      tls,
    }
    let res: any
    try {
      res = await fetch(src!, init)
    } catch (e) {
      timeoutError(e, guards.timeoutMs)
      return fail(`request failed: ${(e as Error).message}`, `is the server running at ${src}?`)
    }
    const ms = Math.round(performance.now() - started)
    const responseTarget = { url: res.url, redirected: res.redirected }
    // curl parity: -f turns HTTP errors into a failing exit code (curl uses
    // 22). Unlike curl we still print the full report — the agent needs the
    // status and body to act, never-silent applies to failures most of all.
    const exitPerFail = (): never => {
      if (flags.fail === true && !res.ok) {
        process.stderr.write(`ax: -f: HTTP ${res.status} -> exit 22\n`)
        process.exit(22)
      }
      process.exit(0)
    }
    if (typeof flags.output === 'string') {
      // curl parity again: -f never saves the error document — whatever sat
      // at the -o path before stays untouched.
      if (flags.fail === true && !res.ok) {
        await writeStdoutFlushed(
          JSON.stringify(
            {
              status: res.status,
              ok: false,
              url: responseTarget.url,
              redirected: responseTarget.redirected,
              ms,
              saved: null,
              note: '-f: error body not saved',
            },
            null,
            2
          ) + '\n'
        )
        exitPerFail()
      }
      // The body is collected in memory and written once, at the end. Neither
      // an incremental file write nor rename has a scriptc lowering, so the
      // old stream-to-temp-then-rename dance is unavailable — but writing only
      // after a complete transfer keeps the property that actually matters:
      // a failed or timed-out download leaves whatever sat at -o untouched,
      // and a shorter download never splices onto the old file's tail. The
      // buffer is bounded by --max-bytes, the same cap the stream enforced.
      let written = 0
      const parts: Uint8Array[] = []
      try {
        const reader = res.body?.getReader()
        if (reader) {
          while (true) {
            const { done, value } = await readWithDeadline(reader, deadline)
            if (done || !value) break
            if (value.byteLength > guards.maxBytes - written) {
              await reader.cancel().catch(() => {})
              return fail(
                `download exceeded --max-bytes at ${guards.maxBytes} bytes (--max-bytes <n> raises the cap; existing file at ${flags.output} untouched)`
              )
            }
            const len = value.byteLength as number
            const chunk = new Uint8Array(len)
            for (let i = 0; i < len; i++) chunk[i] = value[i] as number
            parts.push(chunk)
            written += len
          }
        }
      } catch (e) {
        timeoutError(e, guards.timeoutMs)
        return fail(
          `download failed: ${(e as Error).message} (existing file at ${flags.output} untouched)`
        )
      }
      try {
        const all = new Uint8Array(written)
        let off = 0
        for (const part of parts) {
          all.set(part, off)
          off += part.byteLength
        }
        writeFileSync(flags.output, all)
      } catch (e) {
        return fail(`cannot write to ${flags.output}: ${(e as Error).message}`)
      }
      await writeStdoutFlushed(
        JSON.stringify(
          {
            status: res.status,
            ok: res.ok,
            url: responseTarget.url,
            redirected: responseTarget.redirected,
            ms,
            saved: flags.output,
            bytes: written,
          },
          null,
          2
        ) + '\n'
      )
      process.exit(0)
    }
    let capped: CappedBody
    try {
      capped = await readBodyCapped(res, guards.maxBytes, deadline)
    } catch (e) {
      timeoutError(e, guards.timeoutMs)
      return fail(`read failed: ${(e as Error).message}`)
    }
    // --body: the classic Unix pipe mode — body only on stdout, no display
    // cap (downloads are still bounded by --max-bytes). Anything unusual is
    // announced on stderr so the pipe never lies by omission.
    if (flags.body === true) {
      if (capped.bytes.byteLength > 0) await writeStdoutFlushed(capped.bytes)
      if (res.redirected) process.stderr.write(`ax: note: redirected to ${res.url}\n`)
      if (!res.ok) process.stderr.write(`ax: note: HTTP ${res.status} ${res.statusText}\n`)
      if (capped.bytes.byteLength === 0) process.stderr.write('ax: note: empty body\n')
      if (capped.capped) {
        process.stderr.write(
          `ax: note: download stopped at ${guards.maxBytes} bytes (--max-bytes <n> raises the cap)\n`
        )
      }
      exitPerFail()
    }
    const raw = decodeBody(capped.bytes, res.headers.get('content-type'))
    const budgetTokens = flags.all === true ? Infinity : opts.budget > 0 ? opts.budget : 500
    const maxChars = budgetTokens * 4
    const truncated = raw.length > maxChars
    const bodyText = truncated ? raw.slice(0, maxChars) : raw
    let body: unknown = bodyText
    if (isJsonContentType(res.headers.get('content-type')) && !truncated) {
      try {
        body = JSON.parse(bodyText)
      } catch {
        /* keep text */
      }
    }
    const allHeaders: Record<string, string> = {}
    for (const [k, v] of res.headers.entries()) allHeaders[k as string] = v as string
    let reportHeaders = allHeaders
    let omitted = 0
    if (flags.headers !== true) {
      reportHeaders = {}
      for (const k in allHeaders) {
        if (KEEP_HEADERS.has(k) || k.startsWith('x-ratelimit')) reportHeaders[k] = allHeaders[k]!
        else omitted++
      }
    }
    await writeStdoutFlushed(
      JSON.stringify(
        {
          status: res.status,
          ok: res.ok,
          url: responseTarget.url,
          redirected: responseTarget.redirected,
          ms,
          headers: reportHeaders,
          headers_omitted: omitted > 0 ? `${omitted} (--headers for all)` : undefined,
          body,
          download_capped: capped.capped
            ? `stopped reading at ${guards.maxBytes} bytes (--max-bytes <n> raises the cap)`
            : undefined,
          body_truncated: truncated
            ? `${raw.length - maxChars} of ${raw.length} chars hidden (--all or --budget T)`
            : undefined,
        },
        null,
        2
      ) + '\n'
    )
    exitPerFail()
  }

  // --- parse mode ---
  // -X/-d/-k are curl reflexes too; parse mode gets the same request shape
  // as fetch mode, just handed to readSource instead of fetch() directly.
  // For file/stdin sources there is no request to shape them into — say so
  // rather than dropping them silently.
  const requestInit = isUrl ? await curlRequestInit(flags, headers) : null
  if (!isUrl) {
    const ignored = [
      typeof flags.method === 'string' ? '-X' : null,
      typeof flags.data === 'string' ||
      typeof flags['data-raw'] === 'string' ||
      typeof flags['data-binary'] === 'string'
        ? '-d'
        : null,
      flags.insecure === true ? '-k' : null,
      flags.head === true ? '-I' : null,
    ].filter(Boolean)
    if (ignored.length > 0) {
      process.stderr.write(
        `ax: note: ${ignored.join('/')} ignored — ${src} is not a URL, nothing is fetched\n`
      )
    }
  }
  // A HEAD response has no body to parse — never-silent means we note the
  // downgrade instead of quietly parsing nothing (and every selector failing).
  // "treating as", not "fetching with": the GET may be served from the cache.
  if (requestInit?.method === 'HEAD') {
    requestInit.method = 'GET'
    process.stderr.write(
      'ax: note: HEAD has no body to parse — treating as GET (drop the selector to see headers)\n'
    )
  }
  const guards = guardsFromFlags(flags)
  const sourceOptions: ReadSourceOptions = {
    maxBytes: guards.maxBytes,
    timeoutMs: guards.timeoutMs,
    fresh: guards.fresh,
    noCache: guards.noCache,
    headers,
    method: requestInit?.method,
    body: requestInit?.body,
    tls: requestInit?.tls,
  }
  const { document } = parseHTML(await readSource(src, sourceOptions))
  const wherePred = typeof flags.where === 'string' ? compileWhere(flags.where) : null

  // JS-shell diagnosis: a 200 with an SPA husk is the sneakiest "success".
  const spaNote = (): string | null => {
    const body = document.querySelector('body')
    const text = collapse(body?.textContent ?? '')
    const scripts = document.querySelectorAll('script').length
    if (text.length < 200 && scripts > 0)
      return `body has ${text.length} chars of visible text and ${scripts} script(s) — likely a JS-rendered SPA; ax reads raw HTML (use a browser tool for this page)`
    return null
  }

  const scope = (): DomNode => {
    if (!selector) return document.querySelector('body') ?? document
    const el = query1(document, selector)
    if (!el) {
      const spa = spaNote()
      fail(`selector matched nothing: ${selector}`, spa ?? undefined)
    }
    return el
  }

  if (flags.md) {
    const md = toMarkdown(document.querySelector('html') ?? document)
    // --md carries a default token budget on top of --limit, because markdown
    // lines are cheap individually but a whole page adds up. It is only a
    // *default*: --all means all (never a truncation note pointing at the flag
    // that is already set), and an explicit --budget wins.
    const budget = opts.all || opts.budget > 0 ? opts.budget : 2000
    return emitLines(md.split('\n'), { ...opts, budget })
  }

  if (flags.outline) {
    const counts = new Map<string, number>()
    for (const el of scope().querySelectorAll('*')) {
      const sig = signature(el)
      counts.set(sig, (counts.get(sig) ?? 0) + 1)
    }
    const lines = [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([sig, n]) => `${String(n).padStart(5)}  ${sig}`)
    if (lines.length === 0) {
      const spa = spaNote()
      process.stderr.write(`ax: note: no repeating structures found${spa ? ` — ${spa}` : ''}\n`)
    }
    return emitLines(lines, opts)
  }

  if (typeof flags.locate === 'string') {
    const needle = flags.locate.toLowerCase()
    const hits: { selector: string; match: string }[] = []
    for (const el of scope().querySelectorAll('*')) {
      const attrHit = toStrings(el.getAttributeNames())
        .map((n): [string, string] => [n, (el.getAttribute(n) as string | null) ?? ''])
        .find(([, v]) => v.toLowerCase().includes(needle))
      const childHit = toArray(el.children).some((c) =>
        (((c.textContent as string | null) ?? '') as string).toLowerCase().includes(needle)
      )
      const textHit =
        !childHit &&
        (((el.textContent as string | null) ?? '') as string).toLowerCase().includes(needle)
      if (!attrHit && !textHit) continue
      const snippet = attrHit ? `${attrHit[0]}="${attrHit[1]}"` : collapse(el.textContent ?? '')
      hits.push({
        selector: selectorPath(el),
        match: snippet.length > 80 ? snippet.slice(0, 80) + '…' : snippet,
      })
    }
    if (hits.length === 0) fail(`text not found: ${flags.locate}`)
    return emitStructured(hits)
  }

  if (flags.table) {
    // The predicate is spelled to return a real boolean: an `&&` over dynamic
    // operands yields a dynamic value, which cannot flow into .filter().
    const tables = queryAll(document, selector ?? 'table').filter(
      (el: DomNode): boolean =>
        el.localName === 'table' || (el.querySelector('table') !== null && el.localName !== 'table')
    )
    const targets = tables.flatMap((el) =>
      el.localName === 'table' ? [el] : toArray(el.querySelectorAll('table'))
    )
    if (targets.length === 0) fail(`no <table> found${selector ? ` under: ${selector}` : ''}`)
    // Grid construction per the HTML table model: expand colspan/rowspan,
    // ignore rows of nested tables, consume leading all-<th> rows as header.
    const parse = (table: DomNode) => {
      const allRows = directRows(table)
      if (allRows.length === 0)
        return { headers: [] as string[], rows: [] as Record<string, string | null>[] }
      const cellsOf = directCells
      const grid: (string | undefined)[][] = allRows.map((): (string | undefined)[] => [])
      // Reads and writes past a row's current end are explicit here: scriptc
      // bounds-checks array indexing rather than answering undefined (read) or
      // growing the array (write), so every slot is materialised first.
      const at = (row: (string | undefined)[], i: number): string | undefined =>
        i < row.length ? row[i] : undefined
      const put = (row: (string | undefined)[], i: number, value: string) => {
        while (row.length <= i) row.push(undefined)
        row[i] = value
      }
      allRows.forEach((tr, r) => {
        let c = 0
        for (const cell of cellsOf(tr)) {
          while (at(grid[r]!, c) !== undefined) c++
          const text = collapse((cell.textContent as string | null) ?? '')
          const colspan = (cell.getAttribute('colspan') as string | null) ?? ''
          const rowspan = (cell.getAttribute('rowspan') as string | null) ?? ''
          const cs = Math.max(1, Number(colspan) || 1)
          const rs = Math.max(1, Number(rowspan) || 1)
          for (let dr = 0; dr < rs && r + dr < allRows.length; dr++) {
            for (let dc = 0; dc < cs; dc++) put(grid[r + dr]!, c + dc, text)
          }
          c += cs
        }
      })
      let headerRowCount = 0
      while (
        headerRowCount < allRows.length &&
        cellsOf(allRows[headerRowCount]!).every((c) => c.localName === 'th') &&
        cellsOf(allRows[headerRowCount]!).length > 0
      ) {
        headerRowCount++
      }
      let width = 0
      for (const row of grid) width = Math.max(width, row.length)
      const named: string[] = []
      for (let i = 0; i < width; i++) {
        named.push((headerRowCount > 0 ? at(grid[0]!, i) || `col${i}` : `col${i}`) as string)
      }
      const seen = new Map<string, number>()
      const headers = named.map((h) => {
        const n = (seen.get(h) ?? 0) + 1
        seen.set(h, n)
        return n === 1 ? h : `${h}_${n}`
      })
      const rows: Record<string, string | null>[] = []
      for (const cells of grid.slice(headerRowCount)) {
        const row: Record<string, string | null> = {}
        let hasValue = false
        headers.forEach((h, i) => {
          const v = at(cells, i) ?? null
          row[h] = v
          if (v) hasValue = true
        })
        if (hasValue) rows.push(row)
      }
      return { headers, rows }
    }
    const parsed = targets.map((t: DomNode) => parse(t))
    const beforeWhere = parsed.length === 1 ? parsed[0]!.rows.length : 0
    if (wherePred) {
      for (const p of parsed) p.rows = p.rows.filter((row) => wherePred(row))
    }
    const tableResult = parsed.length === 1 ? parsed[0]!.rows : parsed
    if (parsed.length === 1) rowStats(parsed[0]!.rows, wherePred ? beforeWhere : undefined)
    if (jsonEnvelope || flags.json || parsed.length > 1) return emitStructured(tableResult)
    // Past the guard above there is exactly one table, so this is its rows.
    return emitLines(toTsv(parsed[0]!.rows), opts)
  }

  if (!selector) fail('missing selector', 'ax <url|file|-> <selector>  (or --outline / --md)')
  const els = queryAll(document, selector)
  if (els.length === 0) fail(`selector matched nothing: ${selector}`, spaNote() ?? undefined)

  if (flags.count) {
    process.stdout.write(els.length + '\n')
    return
  }

  if (typeof flags.row === 'string') {
    const fields = parseRowSpec(flags.row)
    const rows = els.map((el) => {
      const obj: Record<string, string | null> = {}
      for (const f of fields) {
        const target = f.sel === '' ? el : query1(el, f.sel)
        if (!target) obj[f.name] = null
        else if (f.attr) obj[f.name] = target.getAttribute(f.attr)
        else obj[f.name] = collapse(target.textContent ?? '')
      }
      return obj
    })
    const rowResult = wherePred ? rows.filter((row) => wherePred(row)) : rows
    rowStats(rowResult, wherePred ? rows.length : undefined)
    if (jsonEnvelope || flags.json) return emitStructured(rowResult)
    return emitLines(toTsv(rowResult), opts)
  }

  if (flags.json || jsonEnvelope) {
    const rows = els.map((el) => {
      const attrs: Record<string, string> = {}
      for (const n of toStrings(el.getAttributeNames())) {
        attrs[n] = (el.getAttribute(n) as string | null) ?? ''
      }
      return {
        text: (((el.textContent as string | null) ?? '') as string).trim(),
        html: el.innerHTML as string,
        attrs,
      }
    })
    return emitStructured(rows)
  }

  if (typeof flags.attr === 'string') {
    const vals: string[] = []
    for (const el of els) {
      const v = el.getAttribute(flags.attr as string) as string | null
      if (v !== null) vals.push(v)
    }
    return emitLines(vals, opts)
  }

  if (flags.html) {
    return emitLines(
      els.map((el): string => el.innerHTML as string),
      opts
    )
  }

  const texts = els.map((el) => collapse(el.textContent ?? ''))
  return emitLines(texts, opts)
}

// Completeness report for extractions: row count + per-field null counts on
// stderr, so the agent never needs a separate verification probe.
function rowStats(rows: Record<string, string | null>[], beforeWhere?: number) {
  if (rows.length === 0) {
    process.stderr.write(
      beforeWhere !== undefined
        ? `ax: note: 0 of ${beforeWhere} rows match --where\n`
        : 'ax: note: 0 rows extracted — check the selector and field spec\n'
    )
    return
  }
  const nulls: string[] = []
  for (const key in rows[0]!) {
    const n = rows.filter((r) => {
      const rec: any = r
      const v = (rec[key] ?? null) as string | null
      return v === null || v === ''
    }).length
    if (n > 0) nulls.push(`${key}: ${n} empty`)
  }
  process.stderr.write(
    `ax: note: ${rows.length} rows extracted${nulls.length ? ` — check: ${nulls.join(', ')}` : ', no empty fields'}\n`
  )
}
