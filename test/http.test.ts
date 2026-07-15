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
const EXACT_LIMIT = 10_000
const BINARY_BODY = Uint8Array.of(0x00, 0xff, 0x41)
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

async function axBytes(args: string[]) {
  const proc = Bun.spawn(['bun', ENTRY, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { out: new Uint8Array(out), err: err.trim(), code }
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/json') return Response.json({ users: [{ name: 'a' }] })
      if (url.pathname === '/redirect')
        return new Response(null, { status: 302, headers: { location: '/json' } })
      if (url.pathname === '/redirect-error')
        return new Response(null, { status: 302, headers: { location: '/nope' } })
      if (url.pathname === '/empty') return new Response('')
      if (url.pathname === '/big') return new Response('x'.repeat(10000))
      if (url.pathname === '/exact-limit') return new Response('x'.repeat(EXACT_LIMIT))
      if (url.pathname === '/binary') return new Response(BINARY_BODY)
      if (url.pathname === '/echo')
        return req.text().then((t) => new Response(`${req.method}:${t}`))
      if (url.pathname === '/echo-bytes')
        return req.arrayBuffer().then((bytes) => new Response(bytes))
      if (url.pathname === '/auth') return new Response(req.headers.get('authorization') ?? 'none')
      if (url.pathname === '/header-page') {
        if (req.headers.get('x-api-key') !== 'parse-secret')
          return new Response('unauthorized', { status: 401 })
        return new Response('<html><body><p class="secret">header access</p></body></html>')
      }
      if (url.pathname === '/basic-page') {
        if (req.headers.get('authorization') !== 'Basic dXNlcjpwYXNz')
          return new Response('unauthorized', { status: 401 })
        return new Response('<html><body><p class="secret">basic access</p></body></html>')
      }
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
  const url = `http://localhost:${server.port}/json`
  const r = await ax([url])
  const rep = JSON.parse(r.out)
  expect(rep.status).toBe(200)
  expect(rep.ok).toBe(true)
  expect(rep.url).toBe(url)
  expect(rep.redirected).toBe(false)
  expect(rep.body.users[0].name).toBe('a')
  expect(typeof rep.ms).toBe('number')
})

test('redirects: structured reports expose the final URL', async () => {
  const finalUrl = `http://localhost:${server.port}/json`
  const redirected = await ax([`http://localhost:${server.port}/redirect`])
  const report = JSON.parse(redirected.out)
  expect(report.url).toBe(finalUrl)
  expect(report.redirected).toBe(true)

  const out = join(dataDir, 'redirect-output.json')
  const saved = await ax([`http://localhost:${server.port}/redirect`, '-o', out])
  const savedReport = JSON.parse(saved.out)
  expect(savedReport.url).toBe(finalUrl)
  expect(savedReport.redirected).toBe(true)
  expect(await Bun.file(out).json()).toEqual({ users: [{ name: 'a' }] })

  await Bun.write(out, 'GOOD')
  const failed = await ax([`http://localhost:${server.port}/redirect-error`, '-f', '-o', out])
  const failedReport = JSON.parse(failed.out)
  expect(failed.code).toBe(22)
  expect(failedReport.url).toBe(`http://localhost:${server.port}/nope`)
  expect(failedReport.redirected).toBe(true)
  expect(await Bun.file(out).text()).toBe('GOOD')
})

test('redirects: --body keeps stdout pure and notes the final URL on stderr', async () => {
  const finalUrl = `http://localhost:${server.port}/json`
  const redirected = await ax([`http://localhost:${server.port}/redirect`, '--body'])
  expect(JSON.parse(redirected.out)).toEqual({ users: [{ name: 'a' }] })
  expect(redirected.err).toBe(`ax: note: redirected to ${finalUrl}`)
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

test('parse mode forwards custom request headers', async () => {
  const r = await ax([
    `http://localhost:${server.port}/header-page`,
    '.secret',
    '-H',
    'x-api-key: parse-secret',
  ])
  expect(r.code).toBe(0)
  expect(r.out).toBe('header access')
})

test('parse mode forwards basic auth', async () => {
  const r = await ax([`http://localhost:${server.port}/basic-page`, '.secret', '-u', 'user:pass'])
  expect(r.code).toBe(0)
  expect(r.out).toBe('basic access')
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

test('guard: an exact --max-bytes response is accepted in fetch, parse, and -o modes', async () => {
  const url = `http://localhost:${server.port}/exact-limit`
  const fetched = await ax([url, '--all', '--max-bytes', String(EXACT_LIMIT)])
  const report = JSON.parse(fetched.out)
  expect(fetched.code).toBe(0)
  expect(report.body).toHaveLength(EXACT_LIMIT)
  expect(report.download_capped).toBeUndefined()

  const parsed = await ax([url, '--outline', '--fresh', '--max-bytes', String(EXACT_LIMIT)])
  expect(parsed.code).toBe(0)
  expect(parsed.err).not.toContain('exceeded')

  const out = join(dataDir, 'exact-limit.bin')
  const saved = await ax([url, '-o', out, '--max-bytes', String(EXACT_LIMIT)])
  expect(saved.code).toBe(0)
  expect(JSON.parse(saved.out).bytes).toBe(EXACT_LIMIT)
  expect((await Bun.file(out).arrayBuffer()).byteLength).toBe(EXACT_LIMIT)
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

test('curl reflexes: -f with -o exits 22 and never saves the error body', async () => {
  const out = `${process.env.TMPDIR ?? '/tmp'}/ax-f-o-test.txt`
  // a previous good download must survive a later -f failure untouched
  await Bun.write(out, 'GOOD')
  const bad = await ax([`http://localhost:${server.port}/nope`, '-f', '-o', out])
  expect(bad.code).toBe(22)
  const rep = JSON.parse(bad.out)
  expect(rep.status).toBe(404)
  expect(rep.saved).toBe(null)
  expect(bad.err).toContain('exit 22')
  expect(await Bun.file(out).text()).toBe('GOOD')
  const good = await ax([`http://localhost:${server.port}/json`, '-f', '-o', out])
  expect(good.code).toBe(0)
  expect(JSON.parse(good.out).saved).toBe(out)
  expect(await Bun.file(out).text()).toContain('users')
  await Bun.file(out).delete()
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

test('--body preserves response bytes for binary pipes', async () => {
  const r = await axBytes([`http://localhost:${server.port}/binary`, '--body'])
  expect(r.code).toBe(0)
  expect([...r.out]).toEqual([...BINARY_BODY])
  expect(r.err).toBe('')
})

test('--data-binary @file sends bytes unchanged', async () => {
  const input = join(dataDir, 'request.bin')
  const bytes = Uint8Array.of(0xff, 0x0a, 0x80)
  await Bun.file(input).write(bytes)
  const r = await axBytes([
    `http://localhost:${server.port}/echo-bytes`,
    '--data-binary',
    `@${input}`,
    '--body',
  ])
  expect(r.code).toBe(0)
  expect([...r.out]).toEqual([...bytes])
  expect(r.err).toBe('')
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

// The #20 canary fired on Bun 1.4.0 (TextDecoder gained windows-1251), but
// 1.4.0's release assets aren't published for CI yet — so this asserts per
// the running runtime's actual capability: native decode where supported,
// the announced UTF-8 fallback where not. Both branches stay exercised as
// long as CI (1.3.14) and dev machines (1.4.0) differ.
const HAS_CP1251 = (() => {
  try {
    new TextDecoder('windows-1251')
    return true
  } catch {
    return false
  }
})()

test('charset: windows-1251 — native decode when supported, else fallback + note', async () => {
  const r = await ax([`http://localhost:${server.port}/cp1251`])
  const rep = JSON.parse(r.out)
  expect(rep.ok).toBe(true)
  expect(rep.body).toContain('still-readable')
  if (HAS_CP1251) {
    expect(rep.body).toContain('Привет')
    expect(r.err).not.toContain('unknown charset')
  } else {
    expect(r.err).toContain('unknown charset "windows-1251"')
  }
})

test('-o: a shorter download fully replaces a longer existing file (truncate regression)', async () => {
  const out = join(dataDir, 'artifact.bin')
  await Bun.file(out).write('THIS-IS-A-MUCH-LONGER-PREVIOUS-CONTENT')
  const r = await ax([`http://localhost:${server.port}/echo`, '-o', out])
  expect(r.code).toBe(0)
  expect(await Bun.file(out).text()).toBe('GET:')
})

test('-o: a failed download leaves the existing file untouched, no tmp debris', async () => {
  const out = join(dataDir, 'precious.bin')
  await Bun.file(out).write('PRECIOUS')
  const r = await ax([`http://localhost:${server.port}/stall`, '-o', out, '-m', '1'])
  expect(r.code).toBe(1)
  expect(await Bun.file(out).text()).toBe('PRECIOUS')
  const { readdirSync } = await import('node:fs')
  expect(readdirSync(dataDir).filter((n) => n.includes('.axtmp-'))).toEqual([])
}, 15000)

test('guard: -o + --max-bytes stops the download, leaves no file, existing file untouched', async () => {
  const out = join(dataDir, 'capped.bin')
  await Bun.file(out).write('OLD-CONTENT')
  const r = await ax([`http://localhost:${server.port}/endless`, '-o', out, '--max-bytes', '10000'])
  expect(r.code).toBe(1)
  expect(r.err).toContain('max-bytes')
  expect(r.err).toContain('10000')
  expect(await Bun.file(out).text()).toBe('OLD-CONTENT')
  const { readdirSync } = await import('node:fs')
  expect(readdirSync(dataDir).filter((n) => n.includes('.axtmp-'))).toEqual([])
})

test('guard: -o into a nonexistent directory fails cleanly, no raw stack trace', async () => {
  const out = '/nonexistent-dir-xyz/out.txt'
  const r = await ax([`http://localhost:${server.port}/json`, '-o', out])
  expect(r.code).not.toBe(0)
  expect(r.err.split('\n').length).toBe(1)
  expect(r.err).toContain('cannot write to')
  expect(r.err).not.toContain('at root (')
})
