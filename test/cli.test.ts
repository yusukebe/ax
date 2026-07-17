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

test('discover: emitted selectors round-trip CSS-special class and id names', () => {
  writeFileSync(
    join(dir, 'special-selectors.html'),
    `<html><body><main>
      <div class="card sm:w-1/2 hover:bg-blue-500">First needle</div>
      <div class="card sm:w-1/2 hover:bg-blue-500">Second needle</div>
      <section id="panel:1">Special id</section>
    </main></body></html>`
  )

  const outline = ax(['special-selectors.html', '--outline'])
  expect(outline.out).toContain(String.raw`div.card.sm\:w-1\/2.hover\:bg-blue-500`)

  const classHit = JSON.parse(ax(['special-selectors.html', '--locate', 'First needle']).out)[0]
  expect(classHit.selector).toBe(String.raw`main > div.card.sm\:w-1\/2.hover\:bg-blue-500`)
  expect(ax(['special-selectors.html', classHit.selector, '--count']).out).toBe('2')

  const idHit = JSON.parse(ax(['special-selectors.html', '--locate', 'Special id']).out)[0]
  expect(idHit.selector).toBe(String.raw`main > section#panel\:1`)
  expect(ax(['special-selectors.html', idHit.selector, '--count']).out).toBe('1')
})

test('extract: --md produces readable markdown', () => {
  const r = ax(['page.html', '--md'])
  expect(r.out).toContain('# Guide')
  expect(r.out).toContain('Intro paragraph.')
  expect(r.out).toContain('```')
  expect(r.out).not.toContain('Home') // nav stripped
})

test('extract: --md converts <a> inside <p>, <li>, <blockquote>, <th>, <td> to [text](url)', () => {
  writeFileSync(
    join(dir, 'links.html'),
    `<html><body><article>
      <h2>Links</h2>
      <p>See <a href="https://example.com">this link</a> for details.</p>
      <blockquote>Quote <a href="/q">source</a></blockquote>
      <ul><li>Item with <a href="/page2">a link</a></li></ul>
      <table><tr><th><a href="/h-sort">Name</a></th><th>Age</th></tr><tr><td><a href="/alice">Alice</a></td><td>30</td></tr></table>
    </article></body></html>`
  )
  const r = ax(['links.html', '--md'])
  expect(r.out).toContain('## Links')
  expect(r.out).toContain('[this link](https://example.com)')
  expect(r.out).toContain('> Quote [source](/q)')
  expect(r.out).toContain('- Item with [a link](/page2)')
  expect(r.out).toContain('[Name](/h-sort) | ')
  expect(r.out).toContain('[Alice](/alice)')
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

test('errors: bad selector is a clean one-line error, no stack trace', () => {
  const r = ax(['page.html', ':::bad('])
  expect(r.code).toBe(1)
  expect(r.err.split('\n')).toHaveLength(1)
  expect(r.err).toContain('ax: error: bad selector:')
  expect(r.err).not.toContain('node_modules')
})

test('errors: bad --row field selector is a clean one-line error', () => {
  const r = ax(['page.html', '.card', '--row', 'title=[data-id="1'])
  expect(r.code).toBe(1)
  expect(r.err.split('\n')).toHaveLength(1)
  expect(r.err).toContain('ax: error: bad selector:')
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

test('--table: colspan/rowspan expansion, multi-row headers, nested tables (#2)', () => {
  writeFileSync(
    join(dir, 'span.html'),
    `<table id="t1"><tr><th>Name</th><th colspan="2">Details</th></tr>
     <tr><td>Alice</td><td>Age 30</td><td>NYC</td></tr></table>
     <table id="t2"><tr><th rowspan="2">Country</th><th colspan="2">Cities</th></tr>
     <tr><th>Capital</th><th>Largest</th></tr>
     <tr><td>Japan</td><td>Tokyo</td><td>Tokyo</td></tr></table>
     <table id="t3"><tr><th>Region</th><th>Country</th><th>City</th></tr>
     <tr><td rowspan="2">Asia</td><td>Japan</td><td>Tokyo</td></tr>
     <tr><td>Korea</td><td>Seoul</td></tr></table>
     <table id="t4"><tr><th>A</th><th>B</th></tr>
     <tr><td>outer1</td><td><table><tr><td>inner1</td><td>inner2</td></tr></table></td></tr></table>`
  )
  const t1 = JSON.parse(ax(['span.html', '#t1', '--table', '--json']).out)
  expect(t1[0]).toEqual({ Name: 'Alice', Details: 'Age 30', Details_2: 'NYC' })
  const t2 = JSON.parse(ax(['span.html', '#t2', '--table', '--json']).out)
  expect(t2[0]).toEqual({ Country: 'Japan', Cities: 'Tokyo', Cities_2: 'Tokyo' })
  const t3 = JSON.parse(ax(['span.html', '#t3', '--table', '--json']).out)
  expect(t3[1]).toEqual({ Region: 'Asia', Country: 'Korea', City: 'Seoul' })
  const t4 = JSON.parse(ax(['span.html', '#t4', '--table', '--json']).out)
  expect(t4).toHaveLength(1)
  expect(t4[0]).toEqual({ A: 'outer1', B: 'inner1inner2' })
})

test('security: ANSI escapes and OSC sequences are stripped from extracted text', () => {
  const ESC = '\x1b'
  const BEL = '\x07'
  writeFileSync(
    join(dir, 'evil.html'),
    `<div><p class="e">safe${ESC}]0;pwned${BEL}text${ESC}[31mred${ESC}[0m</p>` +
      `<p class="e">osc52${ESC}]52;c;${Buffer.from('stolen').toString('base64')}${BEL}end</p></div>`
  )
  const r = ax(['evil.html', '.e'])
  expect(r.out).not.toContain(ESC)
  expect(r.out).not.toContain(BEL)
  expect(r.out).toContain('safe')
  expect(r.out).toContain('red')
  expect(r.err).toContain('control character')
})

test('security: tabs survive in TSV, controls are stripped from cells', () => {
  writeFileSync(
    join(dir, 'evil2.html'),
    '<div><div class="r"><span class="a">x\x1b[2Jy</span><span class="b">ok</span></div></div>'
  )
  const r = ax(['evil2.html', '.r', '--row', 'a=.a, b=.b'])
  expect(r.out.split('\n')[1]).toBe('xy\tok')
})

test('security: JSON output escapes control chars (unchanged behavior)', () => {
  writeFileSync(join(dir, 'evil3.html'), '<p class="j">a\x1b[31mb</p>')
  const r = ax(['evil3.html', '.j', '--row', 'v=', '--json'])
  expect(r.out).toContain('\\u001b')
  expect(JSON.parse(r.out)[0].v).toBe('a\x1b[31mb')
})
