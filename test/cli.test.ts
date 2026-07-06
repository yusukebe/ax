import { test, expect, beforeAll } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Integration tests against the CLI itself. Every bench-discovered bug has a
// regression test here.

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts')
let dir: string

function ax(args: string[], stdin?: string) {
  const proc = Bun.spawnSync(['bun', ENTRY, ...args], {
    cwd: dir,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
  })
  return {
    out: proc.stdout.toString().trim(),
    err: proc.stderr.toString().trim(),
    code: proc.exitCode,
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ax-test-'))
  writeFileSync(
    join(dir, 'log.txt'),
    [
      '2026-01-01 INFO req-1 GET / 200 10ms',
      '2026-01-01 WARN req-2 slow query took 300ms',
      '2026-01-01 INFO req-3 GET / 200 30ms',
      '2026-01-01 ERROR [E101] req-4 boom',
      '2026-01-01 INFO req-5 GET / 200 50ms',
    ].join('\n') + '\n'
  )
  writeFileSync(
    join(dir, 'data.json'),
    JSON.stringify({
      users: [
        { name: 'a', age: 30, plan: 'pro', c: { k: 'JP' } },
        { name: 'b', age: 50, plan: 'free', c: { k: 'US' } },
        { name: 'c', age: 60, plan: 'pro', c: { k: 'JP' } },
      ],
    })
  )
  writeFileSync(
    join(dir, 'page.html'),
    `<ul>
      <li class="card"><a href="/1.htm">One <b>bold</b></a><span class="lv">A1</span></li>
      <li class="card"><a href="/2.htm">Two</a><span class="lv">B2</span></li>
    </ul>
    <table><tr><th>K</th><th>V</th></tr><tr><td>x</td><td>1</td></tr></table>`
  )
  writeFileSync(join(dir, 'lines.ndjson'), '{"a":1}\n{"a":2}\n{"a":3}\n')
})

// REGRESSION: --extract must compose with --grep (was silently extracting
// from ALL lines).
test('text: --grep composes with --extract', () => {
  const r = ax(['text', 'log.txt', '--grep', ' INFO ', '--extract', '(\\d+)ms', '--all'])
  expect(r.out.split('\n')).toEqual(['10', '30', '50'])
})

// REGRESSION: capture-group semantics in --extract.
test('text: --extract emits capture group when present', () => {
  const r = ax(['text', 'log.txt', '--grep', 'WARN', '--extract', 'took (\\d+)ms'])
  expect(r.out).toBe('300')
})

// REGRESSION: --freq without --extract = whole-line frequency.
test('text: --freq works standalone on lines', () => {
  const r = ax(['text', '-', '--freq'], 'a\nb\na\n')
  expect(r.out.split('\n')[0]).toMatch(/2\s+a/)
})

// REGRESSION: stats must skip empty lines (Number('') === 0 counted as 0)
// and accept unit suffixes via parseFloat.
test('stats: skips blanks, accepts unit suffixes', () => {
  const r = ax(['stats', '-'], '10ms\n\n20ms\n\n30ms\n')
  const s = JSON.parse(r.out)
  expect(s.count).toBe(3)
  expect(s.mean).toBe(20)
})

test('stats: percentiles', () => {
  const nums = Array.from({ length: 100 }, (_, i) => String(i + 1)).join('\n')
  const s = JSON.parse(ax(['stats', '-'], nums).out)
  expect(s.p50).toBe(50)
  expect(s.p95).toBe(95)
  expect(s.p99).toBe(99)
})

// REGRESSION: --where with an unquoted string RHS matches 0 rows and must
// print the quoting hint (was silently returning []).
test('json: --where 0-match prints quoting hint', () => {
  const r = ax(['json', 'data.json', '.users[]', '--where', 'plan == pro'])
  expect(r.out).toBe('[]')
  expect(r.err).toContain('quote it')
})

test('json: where + pick + freq in one call', () => {
  const r = ax([
    'json',
    'data.json',
    '.users[]',
    '--where',
    "plan == 'pro'",
    '--pick',
    'c.k',
    '--freq',
  ])
  expect(r.out.split('\n')[0]).toMatch(/2\s+JP/)
})

// REGRESSION: --pick digs dot paths.
test('json: --pick supports dot paths', () => {
  const r = ax(['json', 'data.json', '.users[0]', '--pick', 'c.k'])
  expect(r.out).toBe('"JP"')
})

test('json: --shape summarizes without dumping', () => {
  const r = ax(['json', 'data.json', '--shape'])
  expect(r.out).toContain('array(3)')
  expect(r.out.length).toBeLessThan(300)
})

test('json: NDJSON parses as an array', () => {
  const r = ax(['json', 'lines.ndjson', '.[].a', '--raw'])
  expect(r.out.split('\n')).toEqual(['1', '2', '3'])
})

test('json: --tsv emits header once', () => {
  const r = ax(['json', 'data.json', '.users[]', '--pick', 'name,age', '--tsv'])
  expect(r.out.split('\n')[0]).toBe('name\tage')
  expect(r.out.split('\n')).toHaveLength(4)
})

test('html: --row with @attr and nested tags', () => {
  const r = ax(['html', 'page.html', '.card', '--row', 'title=a, href=a@href, lv=.lv'])
  const rows = JSON.parse(r.out)
  expect(rows[0]).toEqual({ title: 'One bold', href: '/1.htm', lv: 'A1' })
})

test('html: --row --where filters rows', () => {
  const r = ax(['html', 'page.html', '.card', '--row', 'lv=.lv', '--where', 'lv == "B2"'])
  expect(JSON.parse(r.out)).toHaveLength(1)
})

test('html: --table keys rows by headers', () => {
  const r = ax(['html', 'page.html', '--table'])
  expect(JSON.parse(r.out)).toEqual([{ K: 'x', V: '1' }])
})

test('html: --outline and --locate', () => {
  expect(ax(['html', 'page.html', '--outline']).out).toContain('li.card')
  const hits = JSON.parse(ax(['html', 'page.html', '--locate', '2.htm']).out)
  expect(hits[0].selector).toContain('a')
})

test('html: selector matching nothing fails with exit 1', () => {
  const r = ax(['html', 'page.html', '.nope'])
  expect(r.code).toBe(1)
  expect(r.err).toContain('matched nothing')
})

test('enc: base64 roundtrip and jwt peek', () => {
  expect(ax(['enc', 'base64', 'hello ax']).out).toBe('aGVsbG8gYXg=')
  expect(ax(['enc', 'base64', '-d', 'aGVsbG8gYXg=']).out).toBe('hello ax')
  const payload = Buffer.from(JSON.stringify({ sub: 'x', exp: 1783418478 })).toString('base64url')
  const jwt = ax(['enc', 'jwt', `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`])
  expect(JSON.parse(jwt.out).payload.sub).toBe('x')
  expect(JSON.parse(jwt.out).times.exp).toContain('2026')
})

test('time: epoch seconds → iso', () => {
  const r = JSON.parse(ax(['time', '1783332078']).out)
  expect(r.iso).toBe('2026-07-06T10:01:18.000Z')
  expect(r.epoch).toBe(1783332078)
})

test('default cap emits stderr note, --limit works', () => {
  const many = JSON.stringify(Array.from({ length: 60 }, (_, i) => i))
  const r = ax(['json', '-', '.[]', '--raw'], many)
  expect(r.out.split('\n')).toHaveLength(50)
  expect(r.err).toContain('hidden')
  const limited = ax(['json', '-', '.[]', '--raw', '--limit', '5'], many)
  expect(limited.out.split('\n')).toHaveLength(5)
})

test('--budget caps by estimated tokens', () => {
  const many = JSON.stringify(Array.from({ length: 60 }, (_, i) => `item-${i}`))
  const r = ax(['json', '-', '.[]', '--raw', '--budget', '10'], many)
  expect(r.out.split('\n').length).toBeLessThan(10)
  expect(r.err).toContain('hidden')
})
