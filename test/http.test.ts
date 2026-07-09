import { test, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts')
let server: ReturnType<typeof Bun.serve>

// Async spawn: spawnSync would block the event loop that Bun.serve needs to
// answer the child's request — a deadlock.
async function ax(args: string[]) {
  const proc = Bun.spawn(['bun', ENTRY, ...args], { stdout: 'pipe', stderr: 'pipe' })
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
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => server.stop())

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
  const r = await ax([`http://localhost:${server.port}/json`, '-L', '-s', '-i', '-f'])
  expect(JSON.parse(r.out).ok).toBe(true)
  expect(r.err).not.toContain('unknown')
  const out = `${process.env.TMPDIR ?? '/tmp'}/ax-o-test.json`
  const saved = await ax([`http://localhost:${server.port}/json`, '-o', out])
  expect(JSON.parse(saved.out).saved).toBe(out)
  expect(await Bun.file(out).text()).toContain('users')
})
