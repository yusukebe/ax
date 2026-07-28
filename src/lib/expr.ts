import { fail } from './io'

// A tiny, safe expression language for --where. No eval, no side effects.
//
//   price > 100 && stock != 0
//   name ~ /^Lesson/ || level == "A1"
//   !archived && tags.length >= 2
//
// Grammar (precedence low→high): ||  &&  !  (== != ~ !~ > >= < <=)  primary
// Primary: number, 'string', "string", /regex/flags, true/false/null,
//          dot path (name, item.price, tags.length), `column with spaces`,
//          parenthesised expr.

type Tok =
  | { t: 'op'; v: string }
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 're'; v: RegExp }
  | { t: 'path'; v: string[] }
  | { t: 'lp' }
  | { t: 'rp' }

function lex(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const ops = ['&&', '||', '==', '!=', '~', '!~', '>=', '<=', '>', '<', '!']
  while (i < src.length) {
    const c = src.charAt(i)
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '(') {
      toks.push({ t: 'lp' })
      i++
      continue
    }
    if (c === ')') {
      toks.push({ t: 'rp' })
      i++
      continue
    }
    const op = ops.find((o) => src.slice(i).startsWith(o))
    if (op) {
      toks.push({ t: 'op', v: op })
      i += op.length
      continue
    }
    if (c === '/' /* regex literal */) {
      const end = src.indexOf('/', i + 1)
      if (end === -1) fail(`unterminated regex in expression: ${src.slice(i)}`)
      const flagsMatch = /^[a-z]*/.exec(src.slice(end + 1))
      const flags = flagsMatch?.[0] ?? ''
      // 'g'/'y' make .test() stateful through lastIndex, which has no
      // assignable form here; a predicate never wants that anyway.
      const reFlags = flags.replace(/[gy]/g, '')
      try {
        toks.push({ t: 're', v: new RegExp(src.slice(i + 1, end), reFlags) })
      } catch (e) {
        fail(`invalid regex: ${(e as Error).message}`)
      }
      i = end + 1 + flags.length
      continue
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1)
      if (end === -1) fail(`unterminated string in expression: ${src.slice(i)}`)
      toks.push({ t: 'str', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    if (c === '`' /* quoted column name — for headers with spaces */) {
      const end = src.indexOf('`', i + 1)
      if (end === -1) fail(`unterminated \`column name\` in expression: ${src.slice(i)}`)
      toks.push({ t: 'path', v: [src.slice(i + 1, end)] })
      i = end + 1
      continue
    }
    const numMatch = /^-?\d+(\.\d+)?/.exec(src.slice(i))
    if (numMatch) {
      toks.push({ t: 'num', v: Number(numMatch[0]) })
      i += numMatch[0].length
      continue
    }
    const pathMatch = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*/.exec(src.slice(i))
    if (pathMatch) {
      const parts = pathMatch[0].split('.')
      i += pathMatch[0].length
      toks.push({ t: 'path', v: parts })
      continue
    }
    fail(`cannot parse expression near: ${src.slice(i, i + 20)}`)
  }
  return toks
}

type Node =
  | { k: 'lit'; v: string | number | boolean | null }
  | { k: 're'; v: RegExp }
  | { k: 'path'; v: string[] }
  | { k: 'not'; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }

// A guarded `tok?.t` read is a '?.' on a sub-union, which has no lowering:
// the undefined arm is tested explicitly instead.
function isOp(tok: Tok | undefined, op: string): boolean {
  return tok !== undefined && tok.t === 'op' && tok.v === op
}

// The recursive-descent parser is spelled as top-level functions over an
// explicit cursor rather than nested closures over a captured `pos`: mutually
// recursive inner declarations sharing mutable outer state abort at runtime
// under scriptc 0.0.17.
type Cursor = { toks: Tok[]; pos: number }

// Reading past the last token is a bounds error under scriptc, where JS would
// have answered undefined.
function peek(c: Cursor): Tok | undefined {
  return c.pos < c.toks.length ? c.toks[c.pos] : undefined
}

function eat(c: Cursor): Tok | undefined {
  if (c.pos >= c.toks.length) return undefined
  const t = c.toks[c.pos]
  c.pos++
  return t
}

const COMPARISON_OPS = ['==', '!=', '~', '!~', '>', '>=', '<', '<=']

function primary(c: Cursor): Node {
  const t = eat(c)
  if (!t) fail('unexpected end of expression')
  if (t.t === 'lp') {
    const e = or(c)
    const close = eat(c)
    if (!close || close.t !== 'rp') fail('missing ) in expression')
    return e
  }
  if (t.t === 'op' && t.v === '!') return { k: 'not', e: primary(c) }
  if (t.t === 'num') return { k: 'lit', v: t.v }
  if (t.t === 'str') return { k: 'lit', v: t.v }
  if (t.t === 're') return { k: 're', v: t.v }
  if (t.t === 'path') {
    const head = t.v.length > 0 ? t.v[0] : undefined
    if (t.v.length === 1 && (head === 'true' || head === 'false' || head === 'null')) {
      return { k: 'lit', v: head === 'true' ? true : head === 'false' ? false : null }
    }
    return { k: 'path', v: t.v }
  }
  fail(`unexpected token in expression`)
}

function comparison(c: Cursor): Node {
  const left = primary(c)
  const t = peek(c)
  if (t && t.t === 'op' && COMPARISON_OPS.includes(t.v)) {
    eat(c)
    return { k: 'bin', op: t.v, l: left, r: primary(c) }
  }
  return left
}

function and(c: Cursor): Node {
  let left = comparison(c)
  while (isOp(peek(c), '&&')) {
    eat(c)
    left = { k: 'bin', op: '&&', l: left, r: comparison(c) }
  }
  return left
}

function or(c: Cursor): Node {
  let left = and(c)
  while (isOp(peek(c), '||')) {
    eat(c)
    left = { k: 'bin', op: '||', l: left, r: and(c) }
  }
  return left
}

function parse(toks: Tok[]): Node {
  const c: Cursor = { toks, pos: 0 }
  const root = or(c)
  if (c.pos !== toks.length) fail('trailing tokens in expression')
  return root
}

function resolve(path: string[], ctx: unknown): any {
  let v: any = ctx
  for (const p of path) {
    if (v === null || v === undefined) return null
    if (p === 'length') {
      if (typeof v === 'string' || Array.isArray(v)) {
        v = v.length
        continue
      }
    }
    if (typeof v !== 'object') return null
    v = v[p] ?? null
  }
  return v
}

function testRegex(regex: RegExp, value: any): boolean {
  return regex.test(value === null || value === undefined ? '' : String(value))
}

// Numeric-friendly comparison: "25000" > 100 works. Number() has no lowering
// over a dynamic argument, so the string arm is bound to a real `string` first.
function numericish(v: any): any {
  if (typeof v !== 'string') return v
  const s: string = v
  if (s === '') return v
  const n = Number(s)
  return Number.isNaN(n) ? v : n
}

function evalNode(n: Node, ctx: unknown): any {
  switch (n.k) {
    case 'lit':
      return n.v
    case 're':
      return n.v
    case 'path':
      return resolve(n.v, ctx)
    case 'not':
      return !evalNode(n.e, ctx)
    case 'bin': {
      const l = evalNode(n.l, ctx)
      if (n.op === '&&') return Boolean(l) && Boolean(evalNode(n.r, ctx))
      if (n.op === '||') return Boolean(l) || Boolean(evalNode(n.r, ctx))
      const r = evalNode(n.r, ctx)
      const ln = numericish(l)
      const rn = numericish(r)
      switch (n.op) {
        case '==':
          return l === r || ln === rn
        case '!=':
          return l !== r && ln !== rn
        case '~': {
          if (n.r.k !== 're') fail('~ needs a /regex/ on the right')
          return testRegex(n.r.v, l)
        }
        case '!~': {
          if (n.r.k !== 're') fail('!~ needs a /regex/ on the right')
          return !testRegex(n.r.v, l)
        }
        case '>':
          return (ln as number) > (rn as number)
        case '>=':
          return (ln as number) >= (rn as number)
        case '<':
          return (ln as number) < (rn as number)
        case '<=':
          return (ln as number) <= (rn as number)
      }
    }
  }
  return null
}

export function compileWhere(src: string): (ctx: unknown) => boolean {
  const ast = parse(lex(src))
  return (ctx) => Boolean(evalNode(ast, ctx))
}
