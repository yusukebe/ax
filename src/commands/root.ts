import { rename } from 'node:fs/promises'
import { parseHTML } from 'linkedom'
import { parseArgs, num } from '../lib/args'
import {
  readSource,
  fail,
  guardsFromFlags,
  readBodyCapped,
  readWithDeadline,
  timeoutError,
  decodeBody,
  type CappedBody,
} from '../lib/io'
import { emitLines, emitJson, writeStdoutFlushed } from '../lib/emit'
import { compileWhere } from '../lib/expr'
import { toTsv } from '../lib/query'

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
  --md               readable page content as markdown (for reading docs)
  --where <expr>     filter rows: price > 100 && name ~ /^foo/i  (no eval;
                     \`col name\` for headers with spaces)

output shape (token-cheap by design):
  rows default to TSV (header once, ≈40% of JSON tokens); --json for JSON rows
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

function requestHeaders(flags: Record<string, unknown>): Record<string, string> {
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
function query1(root: ParentNode, sel: string): Element | null {
  try {
    return root.querySelector(sel)
  } catch (e) {
    fail(`bad selector: ${sel} (${(e as Error).message})`)
  }
}

function queryAll(root: ParentNode, sel: string): Element[] {
  try {
    return [...root.querySelectorAll(sel)]
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
      result += value[index]
    } else {
      result += `\\${value[index]}`
    }
  }

  return result
}

function signature(el: Element): string {
  const classes = [...el.classList].map(escapeCssIdentifier)
  return el.localName + (classes.length ? '.' + classes.join('.') : '')
}

function selectorPath(el: Element): string {
  const parts: string[] = []
  let node: Element | null = el
  while (node && node.localName !== 'body' && node.localName !== 'html') {
    parts.unshift(node.id ? `${node.localName}#${escapeCssIdentifier(node.id)}` : signature(node))
    node = node.parentElement
  }
  return parts.join(' > ')
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
function hasDescendantIn(
  el: Element,
  tags: Set<string>,
  cache?: WeakMap<Element, boolean>
): boolean {
  const cached = cache?.get(el)
  if (cached !== undefined) return cached
  let found = false
  for (const child of el.children) {
    if (SKIP_TAGS.has(child.localName)) continue
    if (tags.has(child.localName) || hasDescendantIn(child, tags, cache)) {
      found = true
      break
    }
  }
  cache?.set(el, found)
  return found
}

const blockDescendantCache = new WeakMap<Element, boolean>()
const hasBlockDescendant = (el: Element) => hasDescendantIn(el, BLOCK_TAGS, blockDescendantCache)

const hasStructuredContent = (el: Element) => hasDescendantIn(el, STRUCTURED_TAGS)

// Text a browser would actually show for el — used to rescue a link label
// when the normal skip leaves nothing (e.g. <a><button>Buy</button></a>).
function visibleText(el: Element): string {
  let out = ''
  for (const child of el.childNodes) {
    if (child.nodeType === 3) out += (child as Text).data
    if (child.nodeType !== 1) continue
    const ce = child as Element
    if (ce.localName === 'br') {
      out += ' '
    } else if (ce.localName === 'svg') {
      // An icon's accessible name (<svg><title>) is the label a screen
      // reader announces — use it before giving up on the link text.
      out += (ce.querySelector('title')?.textContent ?? '') || ' '
    } else if (INVISIBLE_TAGS.has(ce.localName)) {
      if (!ZERO_FOOTPRINT_TAGS.has(ce.localName)) out += ' '
    } else {
      out += ce.localName === 'img' ? (ce.getAttribute('alt') ?? '') : visibleText(ce)
    }
  }
  return out
}

// A link's markdown label: its inline rendering, or — when the normal skip
// leaves nothing — any text a browser would actually show (button labels,
// svg titles, img alt).
const linkLabel = (el: Element) => collapse(inlineToMd(el)) || collapse(visibleText(el))

// Text of a <pre> with SKIP_TAGS subtrees pruned but whitespace preserved —
// textContent would leak <script>/<style> source into the code fence.
function rawText(el: Element): string {
  let out = ''
  for (const child of el.childNodes) {
    if (child.nodeType === 3) out += (child as Text).data
    else if (child.nodeType === 1 && !SKIP_TAGS.has((child as Element).localName))
      out += rawText(child as Element)
  }
  return out
}

// HTML table model, shared by --md and --table: rows and cells nested in an
// inner table belong to that table, not the one being read.
const directRows = (table: Element) =>
  [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table)
const directCells = (tr: Element) =>
  [...tr.children].filter((c) => c.localName === 'th' || c.localName === 'td')

// --md: readable main content as markdown — the docs-reading path.
// Convert a single inline-context node to markdown, turning <a> into
// [text](url) and skipping SKIP_TAGS content wherever it appears.
function inlineNodeToMd(node: Node): string {
  if (node.nodeType === 3) return (node as Text).data
  if (node.nodeType !== 1) return ''
  const el = node as Element
  // A dropped widget still separates the words around it on screen
  // (Press<button>OK</button>to continue), so it becomes a space, which
  // collapse() later folds into the surrounding whitespace.
  if (SKIP_TAGS.has(el.localName)) return ZERO_FOOTPRINT_TAGS.has(el.localName) ? '' : ' '
  if (el.localName === 'a') {
    const raw = inlineToMd(el)
    const label = linkLabel(el)
    const href = el.getAttribute('href') ?? ''
    // No label anywhere (icon-only link with no alt/title): emit the raw
    // inline text rather than [](url) litter, matching the block branch.
    if (!href || !label) return raw
    // Boundary whitespace stays outside the brackets so a label like
    // "the guide " doesn't glue the link to the following word.
    const lead = /^\s/.test(raw) ? ' ' : ''
    const trail = /\s$/.test(raw) ? ' ' : ''
    return `${lead}[${label}](${href})${trail}`
  }
  if (el.localName === 'br') return ' '
  if (el.localName === 'img') {
    const alt = el.getAttribute('alt') ?? ''
    const src = el.getAttribute('src') ?? ''
    return alt && src && !src.startsWith('data:') ? `![${alt}](${src})` : alt
  }
  // Pad block-level children so adjacent blocks rendered in an inline
  // context (<td><p>a</p><p>b</p></td>, nested table cells) don't fuse
  // into one word.
  const inner = inlineToMd(el)
  const isBlockish =
    BLOCK_TAGS.has(el.localName) ||
    ['tr', 'td', 'th', 'caption', 'thead', 'tbody', 'tfoot'].includes(el.localName)
  return isBlockish ? ` ${inner} ` : inner
}

function inlineToMd(el: Element): string {
  let out = ''
  for (const child of el.childNodes) out += inlineNodeToMd(child)
  return out
}

function toMarkdown(root: Element): string {
  const out: string[] = []
  const walk = (el: Element) => {
    let inline = ''
    const flush = () => {
      const text = collapse(inline)
      if (text) out.push(text)
      inline = ''
    }
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        inline += (child as Text).data
        continue
      }
      if (child.nodeType !== 1) continue
      const ce = child as Element
      const tag = ce.localName
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
          out.push(`${'#'.repeat(Number(tag[1]))} ${text}`)
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
        const caption = [...ce.children].find((c) => c.localName === 'caption')
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
        if (text) out.push(`[${text}](${ce.getAttribute('href')})`)
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
  walk(main as Element)
  return out.join('\n\n')
}

// curl semantics for the data flags: -d/--data and --data-binary treat a
// leading @ as "read this file" (@- means stdin); --data-raw never does —
// that's its entire reason to exist. -d additionally strips CR/LF from file
// contents (curl's documented --data behavior); --data-binary preserves them.
async function readDataFile(ref: string, binary = false): Promise<string | ArrayBuffer> {
  if (ref === '-') {
    return binary ? await Bun.stdin.arrayBuffer() : await Bun.stdin.text()
  }
  if (ref === '') {
    fail(`couldn't read data from file ""`, '--data-raw sends the literal string')
  }
  const file = Bun.file(ref)
  if (!(await file.exists())) {
    fail(`couldn't read data from file "${ref}"`, '--data-raw sends the literal string')
  }
  try {
    return binary ? await file.arrayBuffer() : await file.text()
  } catch (e) {
    fail(
      `couldn't read data from file "${ref}": ${(e as Error).message}`,
      '--data-raw sends the literal string'
    )
  }
}

async function readDataArg(value: string, stripNewlines: boolean): Promise<string | ArrayBuffer> {
  if (!value.startsWith('@')) return value
  const data = await readDataFile(value.slice(1), !stripNewlines)
  return stripNewlines && typeof data === 'string' ? data.replace(/[\r\n]/g, '') : data
}

// -d wins over --data-raw wins over --data-binary when more than one is
// given, matching the precedence of the old .find([data, raw, binary]).
async function resolveData(
  flags: Record<string, unknown>
): Promise<string | ArrayBuffer | undefined> {
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
  flags: Record<string, unknown>,
  headers: Record<string, string>
): Promise<{
  method: string
  body: string | ArrayBuffer | undefined
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
  const mediaType = ((value ?? '').split(';', 1)[0] ?? '').trim().toLowerCase()
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

  const [src, selector] = _
  const opts = {
    limit: num(flags.limit, 50, { flag: '--limit', kind: 'positive integer', fail }),
    all: flags.all === true,
    budget: num(flags.budget, 0, { flag: '--budget', kind: 'positive integer', fail }),
    offset: num(flags.offset, 0, { flag: '--offset', kind: 'non-negative integer', fail }),
  }
  const isUrl = /^https?:\/\//.test(src!)
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
    let res: Response
    try {
      res = await fetch(src!, {
        method,
        headers,
        body: data,
        signal: AbortSignal.timeout(guards.timeoutMs),
        tls,
      })
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
              ...responseTarget,
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
      // Stream to a temp file next to the target, then atomically rename.
      // FileSink does not truncate an existing file (a shorter download used
      // to leave the old file's tail spliced onto the new bytes), and the
      // rename means a failed or timed-out transfer leaves whatever sat at
      // -o before completely untouched — no partials, no franken-files.
      const tmpOut = `${flags.output}.axtmp-${process.pid}`
      let sink: Bun.FileSink
      try {
        sink = Bun.file(tmpOut).writer()
      } catch (e) {
        return fail(`cannot write to ${flags.output}: ${(e as Error).message}`)
      }
      let written = 0
      try {
        const reader = res.body?.getReader()
        if (reader) {
          while (true) {
            const { done, value } = await readWithDeadline(reader, deadline)
            if (done || !value) break
            if (value.byteLength > guards.maxBytes - written) {
              await reader.cancel().catch(() => {})
              await Promise.resolve(sink.end()).catch(() => {})
              await Bun.file(tmpOut)
                .delete()
                .catch(() => {})
              return fail(
                `download exceeded --max-bytes at ${guards.maxBytes} bytes (--max-bytes <n> raises the cap; existing file at ${flags.output} untouched)`
              )
            }
            sink.write(value)
            written += value.byteLength
          }
        }
        await sink.end()
        await rename(tmpOut, flags.output)
      } catch (e) {
        await Promise.resolve(sink.end()).catch(() => {})
        await Bun.file(tmpOut)
          .delete()
          .catch(() => {})
        timeoutError(e, guards.timeoutMs)
        return fail(
          `download failed: ${(e as Error).message} (existing file at ${flags.output} untouched)`
        )
      }
      await writeStdoutFlushed(
        JSON.stringify(
          {
            status: res.status,
            ok: res.ok,
            ...responseTarget,
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
    const allHeaders = Object.fromEntries(res.headers.entries())
    let reportHeaders = allHeaders
    let omitted = 0
    if (flags.headers !== true) {
      reportHeaders = {}
      for (const [k, v] of Object.entries(allHeaders)) {
        if (KEEP_HEADERS.has(k) || k.startsWith('x-ratelimit')) reportHeaders[k] = v
        else omitted++
      }
    }
    await writeStdoutFlushed(
      JSON.stringify(
        {
          status: res.status,
          ok: res.ok,
          ...responseTarget,
          ms,
          headers: reportHeaders,
          ...(omitted > 0 ? { headers_omitted: `${omitted} (--headers for all)` } : {}),
          body,
          ...(capped.capped
            ? {
                download_capped: `stopped reading at ${guards.maxBytes} bytes (--max-bytes <n> raises the cap)`,
              }
            : {}),
          ...(truncated
            ? {
                body_truncated: `${raw.length - maxChars} of ${raw.length} chars hidden (--all or --budget T)`,
              }
            : {}),
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
  const { document } = parseHTML(
    await readSource(src, {
      ...guardsFromFlags(flags),
      headers,
      ...(requestInit ?? {}),
    })
  )
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

  const scope = (): ParentNode => {
    if (!selector) return document.querySelector('body') ?? document
    const el = query1(document, selector)
    if (!el) {
      const spa = spaNote()
      fail(`selector matched nothing: ${selector}`, spa ?? undefined)
    }
    return el as ParentNode
  }

  if (flags.md) {
    const md = toMarkdown((document.querySelector('html') ?? document) as unknown as Element)
    return emitLines(md.split('\n'), { ...opts, budget: opts.budget || 2000 })
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
      const attrHit = el
        .getAttributeNames()
        .map((n) => [n, el.getAttribute(n) ?? ''] as const)
        .find(([, v]) => v.toLowerCase().includes(needle))
      const childHit = [...el.children].some((c) =>
        (c.textContent ?? '').toLowerCase().includes(needle)
      )
      const textHit = !childHit && (el.textContent ?? '').toLowerCase().includes(needle)
      if (!attrHit && !textHit) continue
      const snippet = attrHit ? `${attrHit[0]}="${attrHit[1]}"` : collapse(el.textContent ?? '')
      hits.push({
        selector: selectorPath(el),
        match: snippet.length > 80 ? snippet.slice(0, 80) + '…' : snippet,
      })
    }
    if (hits.length === 0) fail(`text not found: ${flags.locate}`)
    return emitJson(hits, opts)
  }

  if (flags.table) {
    const tables = queryAll(document, selector ?? 'table').filter(
      (el) => el.localName === 'table' || (el.querySelector('table') && el.localName !== 'table')
    )
    const targets = tables.flatMap((el) =>
      el.localName === 'table' ? [el] : [...el.querySelectorAll('table')]
    )
    if (targets.length === 0) fail(`no <table> found${selector ? ` under: ${selector}` : ''}`)
    // Grid construction per the HTML table model: expand colspan/rowspan,
    // ignore rows of nested tables, consume leading all-<th> rows as header.
    const parse = (table: Element) => {
      const allRows = directRows(table)
      if (allRows.length === 0) return { headers: [], rows: [] as Record<string, string | null>[] }
      const cellsOf = directCells
      const grid: (string | undefined)[][] = allRows.map(() => [])
      allRows.forEach((tr, r) => {
        let c = 0
        for (const cell of cellsOf(tr)) {
          while (grid[r]![c] !== undefined) c++
          const text = collapse(cell.textContent ?? '')
          const cs = Math.max(1, Number(cell.getAttribute('colspan')) || 1)
          const rs = Math.max(1, Number(cell.getAttribute('rowspan')) || 1)
          for (let dr = 0; dr < rs && r + dr < allRows.length; dr++) {
            for (let dc = 0; dc < cs; dc++) grid[r + dr]![c + dc] = text
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
      const width = Math.max(...grid.map((row) => row.length))
      const named = Array.from({ length: width }, (_, i) =>
        headerRowCount > 0 ? grid[0]![i] || `col${i}` : `col${i}`
      )
      const seen = new Map<string, number>()
      const headers = named.map((h) => {
        const n = (seen.get(h) ?? 0) + 1
        seen.set(h, n)
        return n === 1 ? h : `${h}_${n}`
      })
      const rows = grid
        .slice(headerRowCount)
        .map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? null])))
        .filter((r) => Object.values(r).some((v) => v))
      return { headers, rows }
    }
    const parsed = targets.map(parse)
    const beforeWhere = parsed.length === 1 ? parsed[0]!.rows.length : 0
    if (wherePred) for (const p of parsed) p.rows = p.rows.filter(wherePred)
    const tableResult = parsed.length === 1 ? parsed[0]!.rows : parsed
    if (parsed.length === 1) rowStats(parsed[0]!.rows, wherePred ? beforeWhere : undefined)
    if (flags.json || parsed.length > 1) return emitJson(tableResult, opts)
    return emitLines(toTsv(tableResult), opts)
  }

  if (!selector) fail('missing selector', 'ax <url|file|-> <selector>  (or --outline / --md)')
  const els = queryAll(document, selector)
  if (els.length === 0) fail(`selector matched nothing: ${selector}`, spaNote() ?? undefined)

  if (flags.count) return void process.stdout.write(els.length + '\n')

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
    const rowResult = wherePred ? rows.filter(wherePred) : rows
    rowStats(rowResult, wherePred ? rows.length : undefined)
    if (flags.json) return emitJson(rowResult, opts)
    return emitLines(toTsv(rowResult), opts)
  }

  if (flags.json) {
    const rows = els.map((el) => ({
      text: (el.textContent ?? '').trim(),
      html: el.innerHTML,
      attrs: Object.fromEntries(el.getAttributeNames().map((n) => [n, el.getAttribute(n) ?? ''])),
    }))
    return emitJson(rows, opts)
  }

  if (typeof flags.attr === 'string') {
    const vals = els
      .map((el) => el.getAttribute(flags.attr as string))
      .filter((v): v is string => v !== null)
    return emitLines(vals, opts)
  }

  if (flags.html) {
    return emitLines(
      els.map((el) => el.innerHTML),
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
  for (const key of Object.keys(rows[0]!)) {
    const n = rows.filter((r) => r[key] === null || r[key] === '').length
    if (n > 0) nulls.push(`${key}: ${n} empty`)
  }
  process.stderr.write(
    `ax: note: ${rows.length} rows extracted${nulls.length ? ` — check: ${nulls.join(', ')}` : ', no empty fields'}\n`
  )
}
