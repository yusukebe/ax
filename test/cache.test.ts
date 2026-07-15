import { test, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readdir, stat, utimes } from 'node:fs/promises'

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts')
const CACHE_DIR = join(homedir(), '.cache', 'ax', 'fetch')

let server: ReturnType<typeof Bun.serve>
let hits: Record<string, number> = {}

async function ax(args: string[]) {
  const proc = Bun.spawn(['bun', ENTRY, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { out: out.trim(), err: err.trim(), code }
}

const keyFor = (url: string) =>
  new Bun.CryptoHasher('sha256').update(url).digest('hex').slice(0, 24)

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      hits[url.pathname] = (hits[url.pathname] ?? 0) + 1
      const value = req.headers.get('x-view') ?? 'hello'
      const html = `<html><body><p class="x">${value}</p></body></html>`
      if (url.pathname === '/nostore')
        return new Response(html, {
          headers: { 'content-type': 'text/html', 'cache-control': 'no-store' },
        })
      return new Response(html, { headers: { 'content-type': 'text/html' } })
    },
  })
})

afterAll(() => server.stop(true))

test('cache: dir is 0700 and files are 0600 (posix)', async () => {
  const url = `http://localhost:${server.port}/perm-check`
  await ax([url, '.x', '--fresh'])
  if (process.platform === 'win32') return
  const dirMode = (await stat(CACHE_DIR)).mode & 0o777
  expect(dirMode).toBe(0o700)
  const fileMode = (await stat(join(CACHE_DIR, keyFor(url)))).mode & 0o777
  expect(fileMode).toBe(0o600)
})

test('cache: Cache-Control no-store is never written to disk', async () => {
  const url = `http://localhost:${server.port}/nostore`
  await ax([url, '.x', '--fresh'])
  expect(await Bun.file(join(CACHE_DIR, keyFor(url))).exists()).toBe(false)
})

test('cache: --no-cache skips read and write', async () => {
  const url = `http://localhost:${server.port}/nocache-check`
  await ax([url, '.x', '--no-cache'])
  await ax([url, '.x', '--no-cache'])
  expect(hits['/nocache-check']).toBe(2)
  expect(await Bun.file(join(CACHE_DIR, keyFor(url))).exists()).toBe(false)
})

test('cache: credential-bearing URLs are not cached', async () => {
  const url = `http://localhost:${server.port}/signed?token=supersecret`
  await ax([url, '.x', '--fresh'])
  expect(await Bun.file(join(CACHE_DIR, keyFor(url))).exists()).toBe(false)
})

test('cache: custom request headers bypass URL cache reads and writes', async () => {
  const url = `http://localhost:${server.port}/header-vary`
  await ax([url, '.x', '--fresh'])
  const first = await ax([url, '.x', '-H', 'x-view: private'])
  const second = await ax([url, '.x', '-H', 'x-view: private'])
  const anonymous = await ax([url, '.x'])
  expect(first.out).toBe('private')
  expect(second.out).toBe('private')
  expect(anonymous.out).toBe('hello')
  expect(anonymous.err).toContain('cached fetch')
  expect(hits['/header-vary']).toBe(3)
})

test('cache: expired entries are swept, tmp files do not linger', async () => {
  const url = `http://localhost:${server.port}/sweep-old`
  await ax([url, '.x', '--fresh'])
  const old = join(CACHE_DIR, keyFor(url))
  const past = new Date(Date.now() - 10 * 60_000)
  await utimes(old, past, past)
  // Any later cache write triggers the sweep.
  await ax([`http://localhost:${server.port}/sweep-new`, '.x', '--fresh'])
  await Bun.sleep(100)
  expect(await Bun.file(old).exists()).toBe(false)
  const leftovers = (await readdir(CACHE_DIR)).filter((n) => n.startsWith('.tmp-'))
  expect(leftovers).toEqual([])
})

test('cache: second read hits cache, not the server', async () => {
  const url = `http://localhost:${server.port}/hit-check`
  await ax([url, '.x', '--fresh'])
  const r = await ax([url, '.x'])
  expect(hits['/hit-check']).toBe(1)
  expect(r.err).toContain('cached fetch')
})
