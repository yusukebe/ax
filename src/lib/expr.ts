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
    const c = src[i]!
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
    const op = ops.find((o) => src.startsWith(o, i))
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
      try {
        toks.push({ t: 're', v: new RegExp(src.slice(i + 1, end), flags) })
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
  | { k: 'lit'; v: unknown }
  | { k: 're'; v: RegExp }
  | { k: 'path'; v: string[] }
  | { k: 'not'; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }

function parse(toks: Tok[]): Node {
  let pos = 0
  const peek = () => toks[pos]
  const eat = () => toks[pos++]

  function primary(): Node {
    const t = eat()
    if (!t) fail('unexpected end of expression')
    if (t.t === 'lp') {
      const e = or()
      const close = eat()
      if (!close || close.t !== 'rp') fail('missing ) in expression')
      return e
    }
    if (t.t === 'op' && t.v === '!') return { k: 'not', e: primary() }
    if (t.t === 'num') return { k: 'lit', v: t.v }
    if (t.t === 'str') return { k: 'lit', v: t.v }
    if (t.t === 're') return { k: 're', v: t.v }
    if (t.t === 'path') {
      const [head] = t.v
      if (t.v.length === 1 && (head === 'true' || head === 'false' || head === 'null')) {
        return { k: 'lit', v: head === 'true' ? true : head === 'false' ? false : null }
      }
      return { k: 'path', v: t.v }
    }
    return fail(`unexpected token in expression`)
  }

  function comparison(): Node {
    let left = primary()
    const t = peek()
    if (t && t.t === 'op' && ['==', '!=', '~', '!~', '>', '>=', '<', '<='].includes(t.v)) {
      eat()
      left = { k: 'bin', op: t.v, l: left, r: primary() }
    }
    return left
  }

  function and(): Node {
    let left = comparison()
    while (peek()?.t === 'op' && (peek() as { v: string }).v === '&&') {
      eat()
      left = { k: 'bin', op: '&&', l: left, r: comparison() }
    }
    return left
  }

  function or(): Node {
    let left = and()
    while (peek()?.t === 'op' && (peek() as { v: string }).v === '||') {
      eat()
      left = { k: 'bin', op: '||', l: left, r: and() }
    }
    return left
  }

  const root = or()
  if (pos !== toks.length) fail('trailing tokens in expression')
  return root
}

function resolve(path: string[], ctx: unknown): unknown {
  let v: unknown = ctx
  for (const p of path) {
    if (v === null || v === undefined) return null
    if (p === 'length') {
      if (typeof v === 'string' || Array.isArray(v)) {
        v = v.length
        continue
      }
    }
    if (typeof v !== 'object') return null
    v = (v as Record<string, unknown>)[p] ?? null
  }
  return v
}

function testRegex(regex: RegExp, value: unknown): boolean {
  regex.lastIndex = 0
  return regex.test(String(value ?? ''))
}

function evalNode(n: Node, ctx: unknown): unknown {
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
      // Numeric-friendly comparison: "25000" > 100 works.
      const ln = typeof l === 'string' && l !== '' && !Number.isNaN(Number(l)) ? Number(l) : l
      const rn = typeof r === 'string' && r !== '' && !Number.isNaN(Number(r)) ? Number(r) : r
      switch (n.op) {
        case '==':
          return l === r || ln === rn
        case '!=':
          return l !== r && ln !== rn
        case '~':
          return r instanceof RegExp ? testRegex(r, l) : fail('~ needs a /regex/ on the right')
        case '!~':
          return r instanceof RegExp ? !testRegex(r, l) : fail('!~ needs a /regex/ on the right')
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
