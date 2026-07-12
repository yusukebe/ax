import { test, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts')
let server: ReturnType<typeof Bun.serve>
let dataDir: string

// Shift_JIS bytes for "こんにちは世界" — can't be produced with TextEncoder
// (UTF-8 only), so the raw bytes are spelled out here.
const SJIS_KONNICHIWA = new Uint8Array([
  0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd, 0x90, 0xa2, 0x8a, 0x45,
])
const ascii = (s: string) => Uint8Array.from(s.split('').map((c) => c.charCodeAt(0)))
const concatBytes = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
const SJIS_HEADER_BODY = concatBytes([
  ascii('<html><head></head><body><p class="msg">'),
  SJIS_KONNICHIWA,
  ascii('</p></body></html>'),
])
const SJIS_META_BODY = concatBytes([
  ascii('<html><head><meta charset="shift_jis"></head><body><p class="msg">'),
  SJIS_KONNICHIWA,
  ascii('</p></body></html>'),
])
const BAD_CHARSET_BODY = ascii('<html><head></head><body><p class="msg">hello</p></body></html>')
// "café €" in windows-1252: 0xE9 = é, 0x80 = € (a C1 control in real ISO-8859-1 —
// the byte that proves the WHATWG iso-8859-1 → windows-1252 alias was applied).
const LATIN1_BODY = concatBytes([
  ascii('<html><head></head><body><p class="msg">caf'),
  Uint8Array.of(0xe9, 0x20, 0x80),
  ascii('</p></body></html>'),
])
// UTF-8 body with a BOM, served under a header that lies about the charset.
const BOM_BODY = concatBytes([
  Uint8Array.of(0xef, 0xbb, 0xbf),
  new TextEncoder().encode(
    '<html><head></head><body><p class="msg">こんにちは世界</p></body></html>'
  ),
])
// "Привет" in windows-1251 — an encoding Bun's TextDecoder does not implement.
const CP1251_BODY = concatBytes([
  ascii('<html><head></head><body><p class="msg">'),
  Uint8Array.of(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2),
  ascii('</p><p class="ok">still-readable</p></body></html>'),
])

// Async spawn: spawnSync would block the event loop that Bun.serve needs to
// answer the child's request — a deadlock.
async function ax(args: string[], stdin?: string) {
  const proc = Bun.spawn(['bun', ENTRY, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { out: out.trim(), err: err.trim(), code }
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/json') return Response.json({ users: [{ name: 'a' }] })
      if (url.pathname === '/empty') return new Response('')
      if (url.pathname === '/big') return new Response('x'.repeat(10000))
      if (url.pathname === '/echo')
        return req.text().then((t) => new Response(`${req.method}:${t}`))
      if (url.pathname === '/auth') return new Response(req.headers.get('authorization') ?? 'none')
      if (url.pathname === '/endless') {
        // 1MB chunked stream, no Content-Length — hostile-sized body without
        // starving the test runner's event loop (a truly infinite pull() would).
        let sent = 0
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (sent >= 256) return controller.close()
              controller.enqueue(new TextEncoder().encode('x'.repeat(4096)))
              sent++
            },
          })
        )
      }
      if (url.pathname === '/sjis-header')
        return new Response(SJIS_HEADER_BODY, {
          headers: { 'content-type': 'text/html; charset=Shift_JIS' },
        })
      if (url.pathname === '/sjis-meta')
        return new Response(SJIS_META_BODY, { headers: { 'content-type': 'text/html' } })
      if (url.pathname === '/bad-charset')
        return new Response(BAD_CHARSET_BODY, {
          headers: { 'content-type': 'text/html; charset=bogus' },
        })
      if (url.pathname === '/latin1')
        return new Response(LATIN1_BODY, {
          headers: { 'content-type': 'text/html; charset=iso-8859-1' },
        })
      if (url.pathname === '/bom-vs-header')
        return new Response(BOM_BODY, {
          headers: { 'content-type': 'text/html; charset=shift_jis' },
        })
      if (url.pathname === '/cp1251')
        return new Response(CP1251_BODY, {
          headers: { 'content-type': 'text/html; charset=windows-1251' },
        })
      if (url.pathname === '/stall') {
        // Sends one chunk, then never finishes.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial-data'))
            },
          })
        )
      }
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => server.stop(true))

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ax-data-'))
  // CRLF in the source file — proves -d strips it while --data-binary keeps it.
  await Bun.file(join(dataDir, 'payload.json')).write('{"a":1}\r\n')
})

afterAll(() => rm(dataDir, { recursive: true, force: true }))

test('http: JSON body is parsed and pipeable', async () => {
  const r = await ax([`http://localhost:${server.port}/json`])
  const rep = JSON.parse(r.out)
  expect(rep.status).toBe(200)
  expect(rep.ok).toBe(true)
  expect(rep.body.users[0].name).toBe('a')
  expect(typeof rep.ms).toBe('number')
})

// The whole point: an empty body still yields a full report (curl -s shows nothing).
test('http: empty body is never silent', async () => {
  const rep = JSON.parse((await ax([`http://localhost:${server.port}/empty`])).out)
  expect(rep.status).toBe(200)
  expect(rep.body).toBe('')
})

test('http: non-2xx is a report, not a crash', async () => {
  const r = await ax([`http://localhost:${server.port}/nope`])
  expect(r.code).toBe(0)
  expect(JSON.parse(r.out).status).toBe(404)
})

test('http: --budget truncates with an explicit note', async () => {
  const rep = JSON.parse((await ax([`http://localhost:${server.port}/big`, '--budget', '10'])).out)
  expect(rep.body.length).toBe(40)
  expect(rep.body_truncated).toContain('hidden')
})

test('http: -d implies POST and sends the body', async () => {
  const rep = JSON.parse((await ax([`http://localhost:${server.port}/echo`, '-d', 'hi'])).out)
  expect(rep.body).toBe('POST:hi')
})

test('http: -d @file sends file contents with CR/LF stripped', async () => {
  const file = join(dataDir, 'payload.json')
  const rep = JSON.parse((await ax([`http://localhost:${server.port}/echo`, '-d', `@${file}`])).out)
  expect(rep.body).toBe('POST:{"a":1}')
})

test('http: --data-binary @file preserves newlines', async () => {
  const file = join(dataDir, 'payload.json')
  const rep = JSON.parse(
    (await ax([`http://localhost:${server.port}/echo`, '--data-binary', `@${file}`])).out
  )
  expect(rep.body).toBe('POST:{"a":1}\r\n')
})

test('http: --data-raw never reads @ as a file — not even one that exists', async () => {
  const url = `http://localhost:${server.port}/echo`
  // The real differentiator: the file exists, and the path must still be
  // sent verbatim. A "read it if it exists" misimplementation passes the
  // missing-file case but fails here.
  const file = join(dataDir, 'payload.json')
  const existing = JSON.parse((await ax([url, '--data-raw', `@${file}`])).out)
  expect(existing.body).toBe(`POST:@${file}`)
  // And a missing file must be sent literally too, not turned into an error.
  const missing = JSON.parse((await ax([url, '--data-raw', '@literal'])).out)
  expect(missing.body).toBe('POST:@literal')
})

test('http: inline -d keeps its newlines — stripping is for @file contents only', async () => {
  const rep = JSON.parse(
    (await ax([`http://localhost:${server.port}/echo`, '-d', 'line1\nline2'])).out
  )
  expect(rep.body).toBe('POST:line1\nline2')
})

test('http: @- reads stdin (-d strips CR/LF, --data-binary preserves)', async () => {
  const url = `http://localhost:${server.port}/echo`
  const stripped = JSON.parse((await ax([url, '-d', '@-'], 'l1\r\nl2\n')).out)
  expect(stripped.body).toBe('POST:l1l2')
  const kept = JSON.parse((await ax([url, '--data-binary', '@-'], 'l1\r\nl2\n')).out)
  expect(kept.body).toBe('POST:l1\r\nl2\n')
})

test('http: -d @missing-file fails with a structured error and hint', async () => {
  const r = await ax([`http://localhost:${server.port}/echo`, '-d', '@no-such-file-here'])
  expect(r.code).toBe(1)
  expect(r.err).toContain(`couldn't read data from file`)
  expect(r.err).toContain('--data-raw sends the literal string')
})

test('http: connection refused is a structured error with a hint', async () => {
  const r = await ax(['http://localhost:1/nope'])
  expect(r.code).toBe(1)
  expect(r.err).toContain('is the server running')
})

test('curl reflexes: -u sends basic auth, -I does HEAD, --data-raw posts', async () => {
  const auth = await ax([`http://localhost:${server.port}/auth`, '-u', 'me:secret'])
  expect(JSON.parse(auth.out).body).toBe('Basic ' + Buffer.from('me:secret').toString('base64'))
  const head = await ax([`http://localhost:${server.port}/echo`, '-I'])
  expect(JSON.parse(head.out).status).toBe(200)
  const raw = await ax([`http://localhost:${server.port}/echo`, '--data-raw', 'xyz'])
  expect(JSON.parse(raw.out).body).toBe('POST:xyz')
})

test('curl reflexes: no-op flags accepted silently, -o saves body', async () => {
  const r = await ax([`http://localhost:${server.port}/json`, '-L', '-s', '-i'])
  expect(JSON.parse(r.out).ok).toBe(true)
  expect(r.err).not.toContain('unknown')
  const out = `${process.env.TMPDIR ?? '/tmp'}/ax-o-test.json`
  const saved = await ax([`http://localhost:${server.port}/json`, '-o', out])
  expect(JSON.parse(saved.out).saved).toBe(out)
  expect(await Bun.file(out).text()).toContain('users')
})

test('guard: endless stream stops at --max-bytes, announced in-band', async () => {
  const r = await ax([`http://localhost:${server.port}/endless`, '--max-bytes', '10000'])
  const rep = JSON.parse(r.out)
  expect(rep.download_capped).toContain('10000 bytes')
  expect(rep.status).toBe(200)
})

test('guard: parse mode refuses a capped body, never half-parses', async () => {
  const r = await ax([
    `http://localhost:${server.port}/endless`,
    '.x',
    '--max-bytes',
    '10000',
    '--fresh',
  ])
  expect(r.code).toBe(1)
  expect(r.err).toContain('exceeded 10000 bytes')
})

test('guard: stalled connection times out with -m, no hang', async () => {
  const r = await ax([`http://localhost:${server.port}/stall`, '-m', '1'])
  expect(r.code).toBe(1)
  expect(r.err).toContain('timed out after 1s')
}, 15000)

test('guard: -o timeout leaves no partial file behind', async () => {
  const out = `${process.env.TMPDIR ?? '/tmp'}/ax-partial-test.bin`
  const r = await ax([`http://localhost:${server.port}/stall`, '-o', out, '-m', '1'])
  expect(r.code).toBe(1)
  expect(await Bun.file(out).exists()).toBe(false)
}, 15000)

test('curl reflexes: -f exits 22 on HTTP errors but still prints the report', async () => {
  const bad = await ax([`http://localhost:${server.port}/nope`, '-f'])
  expect(bad.code).toBe(22)
  expect(JSON.parse(bad.out).status).toBe(404)
  expect(bad.err).toContain('exit 22')
  const good = await ax([`http://localhost:${server.port}/json`, '-f'])
  expect(good.code).toBe(0)
})

test('--body: body only on stdout, uncapped, notes on stderr', async () => {
  const big = await ax([`http://localhost:${server.port}/big`, '--body'])
  expect(big.out.length).toBe(10000) // no display cap in body mode
  expect(big.code).toBe(0)
  const nf = await ax([`http://localhost:${server.port}/nope`, '--body'])
  expect(nf.out).toBe('not found')
  expect(nf.err).toContain('HTTP 404')
  const empty = await ax([`http://localhost:${server.port}/empty`, '--body'])
  expect(empty.out).toBe('')
  expect(empty.err).toContain('empty body')
  const failed = await ax([`http://localhost:${server.port}/nope`, '--body', '-f'])
  expect(failed.code).toBe(22)
})

test('charset: Content-Type charset decodes Shift_JIS (fetch and parse mode)', async () => {
  const url = `http://localhost:${server.port}/sjis-header`
  const fetchRep = JSON.parse((await ax([url])).out)
  expect(fetchRep.body).toContain('こんにちは世界')
  const parsed = await ax([url, '.msg', '--fresh'])
  expect(parsed.out).toBe('こんにちは世界')
})

test('charset: <meta charset> is sniffed when the header has none', async () => {
  const r = await ax([`http://localhost:${server.port}/sjis-meta`, '.msg', '--fresh'])
  expect(r.out).toBe('こんにちは世界')
})

test('charset: unknown label falls back to UTF-8 with a stderr note', async () => {
  const r = await ax([`http://localhost:${server.port}/bad-charset`])
  const rep = JSON.parse(r.out)
  expect(rep.body).toContain('hello')
  expect(r.err).toContain('unknown charset "bogus"')
})

test('charset: iso-8859-1 is decoded as windows-1252 (WHATWG alias)', async () => {
  const r = await ax([`http://localhost:${server.port}/latin1`, '.msg', '--fresh'])
  expect(r.out).toBe('café €')
})

test('charset: a BOM beats a lying Content-Type charset', async () => {
  const r = await ax([`http://localhost:${server.port}/bom-vs-header`, '.msg', '--fresh'])
  expect(r.out).toBe('こんにちは世界')
})

// Canary: windows-1251 is a real-world encoding Bun's TextDecoder currently
// lacks (checked in Bun 1.3.14). If this test starts failing on a Bun upgrade,
// support probably arrived — flip the expectation to a correct decode.
test('charset: encoding Bun lacks (windows-1251) degrades to UTF-8 with a note', async () => {
  const r = await ax([`http://localhost:${server.port}/cp1251`])
  const rep = JSON.parse(r.out)
  expect(rep.ok).toBe(true)
  expect(rep.body).toContain('still-readable')
  expect(r.err).toContain('unknown charset "windows-1251"')
})
