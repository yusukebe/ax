import { test, expect, beforeAll } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

test('extract: --row defaults to TSV, --json for JSON rows', () => {
  const tsv = ax(['page.html', '.card', '--row', 'title=a, href=a@href, lv=.lv']).out
  expect(tsv.split('\n')[0]).toBe('title\thref\tlv')
  expect(tsv.split('\n')[1]).toBe('One bold\t/1.htm\tA1')
  const rows = JSON.parse(
    ax(['page.html', '.card', '--row', 'title=a, href=a@href, lv=.lv', '--json']).out
  )
  expect(rows[0]).toEqual({ title: 'One bold', href: '/1.htm', lv: 'A1' })
})

test('extract: --row --where filters rows', () => {
  const r = ax(['page.html', '.card', '--row', 'lv=.lv', '--where', 'lv == "B2"', '--json'])
  expect(JSON.parse(r.out)).toHaveLength(1)
})

test('extract: --table defaults to TSV', () => {
  expect(ax(['page.html', '--table']).out).toBe('K\tV\nx\t1')
  expect(JSON.parse(ax(['page.html', '--table', '--json']).out)).toEqual([{ K: 'x', V: '1' }])
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

test('0 rows after --where is announced, never silent', () => {
  writeFileSync(
    join(dir, 'zero.html'),
    '<table class="t"><tr><th>Name</th><th>Stars</th></tr><tr><td>a</td><td>5</td></tr></table>'
  )
  const r = ax(['zero.html', '.t', '--table', '--where', 'Stars > 100'])
  expect(r.err).toContain('0 of 1 rows match --where')
})

test('JS-shell SPA is diagnosed, not silent', () => {
  writeFileSync(
    join(dir, 'spa.html'),
    '<html><head><script src="/a.js"></script></head><body><div id="root"></div></body></html>'
  )
  const outline = ax(['spa.html', '--outline'])
  expect(outline.err).toContain('likely a JS-rendered SPA')
  const sel = ax(['spa.html', '.item'])
  expect(sel.err).toContain('likely a JS-rendered SPA')
})
