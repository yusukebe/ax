import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmod, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { num, type FlagValue } from './args'
import { decodeText } from './platform'

// Explore-then-extract means the same URL gets probed many times in a row;
// re-downloading it every probe wastes seconds per turn. Short-TTL cache.
const FETCH_CACHE = join(homedir(), '.cache', 'ax', 'fetch')
const FETCH_TTL_MS = 120_000

// Guardrails for fetching untrusted responses: a hostile or broken server
// must not be able to fill memory/disk or hang the agent's turn.
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024 // 20MB of decoded body
export const DEFAULT_TIMEOUT_MS = 30_000

export type FetchGuards = {
  maxBytes?: number
  timeoutMs?: number
  fresh?: boolean
  noCache?: boolean
}

export type ReadSourceOptions = FetchGuards & {
  headers?: Record<string, string>
  method?: string
  body?: string | Uint8Array
  tls?: { rejectUnauthorized: boolean }
}

export function guardsFromFlags(flags: Record<string, FlagValue>): Required<FetchGuards> {
  const maxBytes = num(flags['max-bytes'], DEFAULT_MAX_BYTES, {
    flag: '--max-bytes',
    kind: 'positive integer',
    fail: (message: string) => fail(message),
  })
  const timeoutMs =
    num(flags['max-time'], DEFAULT_TIMEOUT_MS / 1000, {
      flag: '-m/--max-time',
      kind: 'positive number',
      fail: (message: string) => fail(message),
    }) * 1000
  return {
    maxBytes,
    timeoutMs,
    fresh: flags.fresh === true,
    noCache: flags['no-cache'] === true,
  }
}

// Cached pages can contain private content, so the cache is owner-only:
// directory 0700, files 0600. The entry is created with its final mode rather
// than written-then-renamed: rename has no scriptc lowering, so the atomic
// swap is unavailable and a concurrent reader can observe a short file. The
// TTL check treats that as a miss on the next read, and the permission bits —
// the part that actually protects private content — are set at creation.
async function cacheWrite(key: string, text: string): Promise<void> {
  try {
    mkdirSync(FETCH_CACHE, { recursive: true, mode: 0o700 })
    // mkdir leaves a pre-existing dir's mode alone — tighten it explicitly
    // so caches created by older ax versions are fixed too.
    if (process.platform !== 'win32') await chmod(FETCH_CACHE, 0o700).catch(() => {})
    writeFileSync(join(FETCH_CACHE, key), text, { mode: 0o600 })
  } catch {
    // Caching is an optimization; failing to cache must never fail the read.
  }
  sweepExpired().catch(() => {})
}

// Drop entries past their TTL so stale private content does not sit on
// disk indefinitely. Runs opportunistically after writes; the dir is tiny.
async function sweepExpired(): Promise<void> {
  const entries = await readdir(FETCH_CACHE).catch(() => [] as string[])
  const now = Date.now()
  for (const name of entries) {
    const p = join(FETCH_CACHE, name)
    const s = await stat(p).catch(() => null)
    if (!s) continue
    const expired = now - s.mtimeMs > FETCH_TTL_MS
    if (expired || name.startsWith('.tmp-')) await unlink(p).catch(() => {})
  }
}

// URLs that visibly carry credentials should not leave bodies on disk.
const SENSITIVE_QUERY_PART =
  /(?:^|[_-])(?:token|api[_-]?key|key|secret|signature|sig|credential|password|authorization|auth)(?:$|[_-])/

function hasSensitiveQuery(src: string): boolean {
  // The iterator has to be consumed directly in the for-of head — it has no
  // standalone value form under scriptc.
  for (const name of new URL(src).searchParams.keys()) {
    const normalized = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    if (SENSITIVE_QUERY_PART.test(normalized)) return true
  }
  return false
}

// fd 0 covers every stdin shape (pipe, redirect, tty) on the platforms ax
// ships for, and is the one form both Bun and a compiled binary agree on.
export function readStdinText(): string {
  return readFileSync(0, 'utf8')
}

export function readStdinBytes(): Uint8Array {
  const buf = readFileSync(0)
  return new Uint8Array(buf)
}

export type CappedBody = { bytes: Uint8Array; capped: boolean }

// Recognised by timeoutError() in place of an `Error & { name }` intersection,
// which resolves to no runtime shape under scriptc.
export const BODY_TIMEOUT_MESSAGE = 'body read timed out'

// reader.read() that cannot outlive the deadline. The fetch AbortSignal is
// not reliably propagated to in-flight body reads, so a server that sends
// headers and then goes quiet would hang the agent's turn forever.
//
// The deadline is enforced by cancelling the reader rather than racing the
// read against a timer: Promise.race has no lowering over a dynamically typed
// promise, and cancelling settles the pending read anyway. `reader` is
// deliberately untyped — scriptc has no lowering for the statically typed
// ReadableStream surface, but the same object reached through a dynamic value
// keeps every method. See readBodyCapped for where it comes from.
export async function readWithDeadline(
  reader: any,
  deadline: number
): Promise<{ done: boolean; value?: any }> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    await reader.cancel().catch(() => {})
    throw new Error(BODY_TIMEOUT_MESSAGE)
  }
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    Promise.resolve(reader.cancel()).catch(() => {})
  }, remaining)
  try {
    const r = await reader.read()
    if (expired) throw new Error(BODY_TIMEOUT_MESSAGE)
    return { done: r.done === true, value: r.value }
  } catch (e) {
    await reader.cancel().catch(() => {})
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// Stream a response body, stopping at maxBytes of *received* data — never
// buffer an unbounded body just to truncate it afterwards.
export async function readBodyCapped(
  res: any,
  maxBytes: number,
  deadline: number
): Promise<CappedBody> {
  const reader = res.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(0), capped: false }
  const chunks: any[] = []
  let total = 0
  let capped = false
  while (true) {
    const { done, value } = await readWithDeadline(reader, deadline)
    if (done || !value) break
    const room = maxBytes - total
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room))
      total = maxBytes
      capped = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    total += value.byteLength
  }
  const bytes = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    // .set has no lowering from a dynamic source; copy element-wise instead.
    const len = c.byteLength as number
    for (let i = 0; i < len; i++) bytes[off + i] = c[i] as number
    off += len
  }
  return { bytes, capped }
}

export function timeoutError(e: unknown, timeoutMs: number): never | null {
  const err = e as { name?: string; message?: string }
  const name = err?.name
  if (name === 'TimeoutError' || name === 'AbortError' || err?.message === BODY_TIMEOUT_MESSAGE) {
    fail(`request timed out after ${timeoutMs / 1000}s`, '-m <secs> raises the timeout')
  }
  return null
}

// Decide a response body's text encoding the way a browser would (simplified):
// a byte-order mark beats everything (even the header), then the Content-Type
// charset, then a <meta charset> sniffed from the first 1KB, else UTF-8.
// Label normalization/aliasing is left to TextDecoder itself.
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const label = bomLabel(bytes) ?? headerCharset(contentType) ?? metaCharset(bytes) ?? 'utf-8'
  const text = decodeText(bytes, label)
  if (text !== null) return text
  // Unknown/unsupported label — never crash a fetch over a bad charset claim.
  process.stderr.write(`ax: note: unknown charset "${label}", decoding as UTF-8\n`)
  return decodeText(bytes, 'utf-8') ?? ''
}

function bomLabel(bytes: Uint8Array): string | null {
  // Length-checked: a typed-array read past the end is a bounds error under
  // scriptc, and a HEAD response arrives here with zero bytes.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return null
}

function headerCharset(contentType: string | null): string | null {
  const m = contentType ? /charset=("?)([^;"\s]+)\1/i.exec(contentType) : null
  return m?.[2] ?? null
}

// Meta tags are ASCII regardless of the page's real encoding, so a latin1
// (byte-for-codepoint) decode of the first 1KB is enough to find them without
// knowing the charset yet.
function metaCharset(bytes: Uint8Array): string | null {
  const head = decodeText(bytes.subarray(0, 1024), 'latin1') ?? ''
  const direct = /<meta\b[^>]*\bcharset\s*=\s*["']?([^"'\s/>;]+)/i.exec(head)
  const httpEquiv =
    /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-type["']?[^>]*\bcontent\s*=\s*["'][^"']*charset=([^"'\s;]+)/i.exec(
      head
    )
  const label = direct?.[1] ?? httpEquiv?.[1]
  if (!label) return null
  // WHATWG sniffing treats a meta-declared UTF-16 as bogus (such a document
  // couldn't have valid ASCII meta tags to sniff in the first place) and
  // coerces it to UTF-8.
  return /^utf-16/i.test(label) ? 'utf-8' : label
}

// Read a source that is a URL, a file path, or "-" (stdin).
export async function readSource(
  src: string | undefined,
  options?: ReadSourceOptions
): Promise<string> {
  if (src === undefined || src === '-') {
    return readStdinText()
  }
  if (/^https?:\/\//.test(src)) {
    // Spreads must come first in an object literal under scriptc.
    const g = {
      ...options,
      maxBytes: options?.maxBytes ?? DEFAULT_MAX_BYTES,
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }
    const key = createHash('sha256').update(src).digest('hex').slice(0, 24)
    const cachedPath = join(FETCH_CACHE, key)
    const cachedStat = await stat(cachedPath).catch(() => null)
    const fresh = options?.fresh ?? process.argv.includes('--fresh')
    const hasCustomHeaders = Object.keys(options?.headers ?? {}).length > 0
    // A non-GET method or a body makes this request too unlike a plain page
    // view to share the URL-keyed cache — same reasoning as hasCustomHeaders
    // above. -k is not disqualifying here: reading a cache entry that was
    // itself written by a verified fetch is safe regardless of -k (see the
    // write-side check below, which is where -k actually matters).
    const hasRequestOverrides =
      (options?.method !== undefined && options.method !== 'GET') || options?.body !== undefined
    const noCache =
      (options?.noCache ?? process.argv.includes('--no-cache')) ||
      hasCustomHeaders ||
      hasRequestOverrides
    if (
      !fresh &&
      !noCache &&
      cachedStat !== null &&
      Date.now() - cachedStat.mtimeMs < FETCH_TTL_MS
    ) {
      const age = Math.round((Date.now() - cachedStat.mtimeMs) / 1000)
      process.stderr.write(`ax: note: using ${age}s-old cached fetch (--fresh to refetch)\n`)
      return await readFile(cachedPath, 'utf8')
    }
    const deadline = Date.now() + g.timeoutMs
    // The init object is untyped so `tls` (not in the standard RequestInit)
    // survives, and `res` is untyped so its streaming surface stays reachable
    // under scriptc — see readWithDeadline.
    const init: any = {
      headers: options?.headers,
      method: options?.method,
      body: options?.body,
      signal: AbortSignal.timeout(g.timeoutMs),
      tls: options?.tls,
    }
    let res: any
    let body: CappedBody
    try {
      res = await fetch(src, init)
      if (!res.ok) fail(`fetch failed: ${res.status} ${res.statusText} for ${src}`)
      body = await readBodyCapped(res, g.maxBytes, deadline)
    } catch (e) {
      timeoutError(e, g.timeoutMs)
      throw e
    }
    if (body.capped) {
      fail(
        `response exceeded ${g.maxBytes} bytes; stopped reading`,
        `--max-bytes <n> raises the download cap`
      )
    }
    const text = decodeBody(body.bytes, res.headers.get('content-type'))
    // Only complete bodies are cached — a capped or aborted read must never
    // be served later as if it were the real page. Servers that say
    // no-store, credential-bearing URLs, and --no-cache all skip the disk.
    // -k also skips writing: an unverified TLS body must never be handed
    // back later to a normal, verified fetch of the same URL.
    const noStore = (res.headers.get('cache-control') ?? '').toLowerCase().includes('no-store')
    if (!noCache && !noStore && !hasSensitiveQuery(src) && options?.tls === undefined) {
      await cacheWrite(key, text)
    }
    return text
  }
  const exists = (await stat(src).catch(() => null)) !== null
  if (!exists) fail(`no such file: ${src}`)
  return await readFile(src, 'utf8')
}

// Structured, single-line error to stderr, then exit. Keeps agent retries cheap.
export function fail(msg: string, hint?: string): never {
  process.stderr.write(`ax: error: ${msg}${hint ? `\n  hint: ${hint}` : ''}\n`)
  process.exit(1)
}
