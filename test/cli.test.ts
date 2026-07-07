import { test, expect, beforeAll } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// Integration tests for the single-command surface: ax <src> [selector] [flags]

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
    join(dir, 'page.html'),
    `<html><body>
      <nav><a href="/">Home</a></nav>
      <article>
        <h1>Guide</h1>
        <p>Intro paragraph.</p>
        <pre>code here</pre>
      </article>
      <ul>
        <li class="card"><a href="/1.htm">One <b>bold</b></a><span class="lv">A1</span></li>
        <li class="card"><a href="/2.htm">Two</a><span class="lv">B2</span></li>
      </ul>
      <table><tr><th>K</th><th>V</th></tr><tr><td>x</td><td>1</td></tr></table>
    </body></html>`
  )
})

test('extract: --row with @attr and nested tags', () => {
  const rows = JSON.parse(ax(['page.html', '.card', '--row', 'title=a, href=a@href, lv=.lv']).out)
  expect(rows[0]).toEqual({ title: 'One bold', href: '/1.htm', lv: 'A1' })
})

test('extract: --row --where filters rows', () => {
  const r = ax(['page.html', '.card', '--row', 'lv=.lv', '--where', 'lv == "B2"'])
  expect(JSON.parse(r.out)).toHaveLength(1)
})

test('extract: --table keys rows by headers', () => {
  expect(JSON.parse(ax(['page.html', '--table']).out)).toEqual([{ K: 'x', V: '1' }])
})

test('discover: --outline and --locate', () => {
  expect(ax(['page.html', '--outline']).out).toContain('li.card')
  const hits = JSON.parse(ax(['page.html', '--locate', '2.htm']).out)
  expect(hits[0].selector).toContain('a')
})

test('extract: --md produces readable markdown', () => {
  const r = ax(['page.html', '--md'])
  expect(r.out).toContain('# Guide')
  expect(r.out).toContain('Intro paragraph.')
  expect(r.out).toContain('```')
  expect(r.out).not.toContain('Home') // nav stripped
})

test('extract: --count and --attr', () => {
  expect(ax(['page.html', '.card', '--count']).out).toBe('2')
  expect(ax(['page.html', '.card a', '--attr', 'href']).out.split('\n')).toEqual([
    '/1.htm',
    '/2.htm',
  ])
})

test('extract: --tsv emits header once', () => {
  const r = ax(['page.html', '.card', '--row', 'lv=.lv', '--tsv'])
  expect(r.out.split('\n')[0]).toBe('lv')
  expect(r.out.split('\n')).toHaveLength(3)
})

test('errors: missing selector hint, exit 1 on no match', () => {
  const r = ax(['page.html', '.nope'])
  expect(r.code).toBe(1)
  expect(r.err).toContain('matched nothing')
})

test('unknown flag warns instead of silently ignoring', () => {
  const r = ax(['page.html', '.card', '--raw'])
  expect(r.err).toContain('unknown flag --raw')
})

test('cap: default limit with stderr note', () => {
  const many = `<ul>${Array.from({ length: 60 }, (_, i) => `<li class="x">i${i}</li>`).join('')}</ul>`
  writeFileSync(join(dir, 'many.html'), many)
  const r = ax(['many.html', '.x'])
  expect(r.out.split('\n')).toHaveLength(50)
  expect(r.err).toContain('hidden')
})

const cached = await Bun.file(join(homedir(), '.cache', 'ax', 'minilm-q8.onnx')).exists()
test.skipIf(!cached)('--like ranks matches by meaning', () => {
  writeFileSync(
    join(dir, 'reviews.html'),
    `<div><p class="r">battery dies in two hours</p><p class="r">screen is gorgeous</p><p class="r">charger overheats badly</p></div>`
  )
  const r = ax(['reviews.html', '.r', '--like', 'power and charging problems', '--limit', '2'])
  const lines = r.out.split('\n')
  expect(lines.join(' ')).toContain('charger')
  expect(lines.join(' ')).not.toContain('gorgeous')
})
