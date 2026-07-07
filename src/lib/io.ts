import { homedir } from 'node:os'
import { join } from 'node:path'

// Explore-then-extract means the same URL gets probed many times in a row;
// re-downloading it every probe wastes seconds per turn. Short-TTL cache.
const FETCH_CACHE = join(homedir(), '.cache', 'ax', 'fetch')
const FETCH_TTL_MS = 120_000

// Read a source that is a URL, a file path, or "-" (stdin).
export async function readSource(src: string | undefined): Promise<string> {
  if (src === undefined || src === '-') {
    return await Bun.stdin.text()
  }
  if (/^https?:\/\//.test(src)) {
    const key = new Bun.CryptoHasher('sha256').update(src).digest('hex').slice(0, 24)
    const cached = Bun.file(join(FETCH_CACHE, key))
    if (
      !process.argv.includes('--fresh') &&
      (await cached.exists()) &&
      Date.now() - cached.lastModified < FETCH_TTL_MS
    ) {
      const age = Math.round((Date.now() - cached.lastModified) / 1000)
      process.stderr.write(`ax: note: using ${age}s-old cached fetch (--fresh to refetch)\n`)
      return await cached.text()
    }
    const res = await fetch(src)
    if (!res.ok) fail(`fetch failed: ${res.status} ${res.statusText} for ${src}`)
    const body = await res.text()
    await Bun.write(join(FETCH_CACHE, key), body)
    return body
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
