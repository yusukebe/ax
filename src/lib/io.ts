import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmod, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'

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

export function guardsFromFlags(flags: Record<string, unknown>): Required<FetchGuards> {
  const mb = typeof flags['max-bytes'] === 'string' ? Number(flags['max-bytes']) : NaN
  const mt = typeof flags['max-time'] === 'string' ? Number(flags['max-time']) * 1000 : NaN
  return {
    maxBytes: Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_BYTES,
    timeoutMs: Number.isFinite(mt) && mt > 0 ? mt : DEFAULT_TIMEOUT_MS,
    fresh: flags.fresh === true,
    noCache: flags['no-cache'] === true,
  }
}

// Cached pages can contain private content, so the cache is owner-only:
// directory 0700, files 0600, written to a temp name then atomically
// renamed (a concurrent read never sees a half-written body). Platforms
// without POSIX modes (Windows) just skip the permission bits.
async function cacheWrite(key: string, text: string): Promise<void> {
  try {
    await mkdir(FETCH_CACHE, { recursive: true, mode: 0o700 })
    // mkdir leaves a pre-existing dir's mode alone — tighten it explicitly
    // so caches created by older ax versions are fixed too.
    if (process.platform !== 'win32') await chmod(FETCH_CACHE, 0o700).catch(() => {})
    const tmp = join(FETCH_CACHE, `.tmp-${key}-${process.pid}`)
    await writeFile(tmp, text, { mode: 0o600 })
    await rename(tmp, join(FETCH_CACHE, key))
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
const SENSITIVE_URL = /[?&](token|api[_-]?key|key|secret|signature|sig|password|auth)=/i

export type CappedBody = { bytes: Uint8Array; capped: boolean }

const timedOut = () =>
  Object.assign(new Error('body read timed out'), { name: 'TimeoutError' as const })

// reader.read() that cannot outlive the deadline. The fetch AbortSignal is
// not reliably propagated to in-flight body reads, so a server that sends
// headers and then goes quiet would hang the agent's turn forever.
export async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number
): Promise<{ done: boolean; value?: Uint8Array }> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    await reader.cancel().catch(() => {})
    throw timedOut()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timedOut()), remaining)
      }),
    ])
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
  res: Response,
  maxBytes: number,
  deadline: number
): Promise<CappedBody> {
  const reader = res.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(0), capped: false }
  const chunks: Uint8Array[] = []
  let total = 0
  let capped = false
  while (true) {
    const { done, value } = await readWithDeadline(reader, deadline)
    if (done || !value) break
    const room = maxBytes - total
    if (value.byteLength >= room) {
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
    bytes.set(c, off)
    off += c.byteLength
  }
  return { bytes, capped }
}

export function timeoutError(e: unknown, timeoutMs: number): never | null {
  const name = (e as { name?: string })?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    fail(`request timed out after ${timeoutMs / 1000}s`, '-m <secs> raises the timeout')
  }
  return null
}

// Read a source that is a URL, a file path, or "-" (stdin).
export async function readSource(src: string | undefined, guards?: FetchGuards): Promise<string> {
  if (src === undefined || src === '-') {
    return await Bun.stdin.text()
  }
  if (/^https?:\/\//.test(src)) {
    const g = { maxBytes: DEFAULT_MAX_BYTES, timeoutMs: DEFAULT_TIMEOUT_MS, ...guards }
    const key = new Bun.CryptoHasher('sha256').update(src).digest('hex').slice(0, 24)
    const cached = Bun.file(join(FETCH_CACHE, key))
    const fresh = guards?.fresh ?? process.argv.includes('--fresh')
    const noCache = guards?.noCache ?? process.argv.includes('--no-cache')
    if (
      !fresh &&
      !noCache &&
      (await cached.exists()) &&
      Date.now() - cached.lastModified < FETCH_TTL_MS
    ) {
      const age = Math.round((Date.now() - cached.lastModified) / 1000)
      process.stderr.write(`ax: note: using ${age}s-old cached fetch (--fresh to refetch)\n`)
      return await cached.text()
    }
    const deadline = Date.now() + g.timeoutMs
    let res: Response
    let body: CappedBody
    try {
      res = await fetch(src, { signal: AbortSignal.timeout(g.timeoutMs) })
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
    const text = new TextDecoder().decode(body.bytes)
    // Only complete bodies are cached — a capped or aborted read must never
    // be served later as if it were the real page. Servers that say
    // no-store, credential-bearing URLs, and --no-cache all skip the disk.
    const noStore = (res.headers.get('cache-control') ?? '').toLowerCase().includes('no-store')
    if (!noCache && !noStore && !SENSITIVE_URL.test(src)) {
      await cacheWrite(key, text)
    }
    return text
  }
  const file = Bun.file(src)
  if (!(await file.exists())) fail(`no such file: ${src}`)
  return await file.text()
}

// Structured, single-line error to stderr, then exit. Keeps agent retries cheap.
export function fail(msg: string, hint?: string): never {
  process.stderr.write(`ax: error: ${msg}${hint ? `\n  hint: ${hint}` : ''}\n`)
  process.exit(1)
}
