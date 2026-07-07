import { fail } from './io'
import { emitLines, emitJson } from './emit'
import { num } from './args'
import { compileWhere } from './expr'

// The jq-subset path language shared by `ax json` and `ax yaml`.

type Step = { kind: 'key'; name: string } | { kind: 'iter' } | { kind: 'index'; i: number }

function parsePath(path: string): Step[] {
  // jq-compat: `.[0]` / `.["k"]` / `.[]` are the same as `[0]` / `["k"]` / `[]`.
  path = path.replace(/\.(?=\[)/g, '')
  if (path === '' || path === '.') return []
  const steps: Step[] = []
  const re = /\.([A-Za-z_$][\w$-]*)|\["([^"]+)"\]|\[(\d+)\]|\[\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(path)) !== null) {
    if (m.index !== last) fail(`cannot parse path near: ${path.slice(last)}`)
    if (m[1] !== undefined) steps.push({ kind: 'key', name: m[1] })
    else if (m[2] !== undefined) steps.push({ kind: 'key', name: m[2] })
    else if (m[3] !== undefined) steps.push({ kind: 'index', i: Number(m[3]) })
    else steps.push({ kind: 'iter' })
    last = re.lastIndex
  }
  if (last !== path.length) fail(`cannot parse path near: ${path.slice(last)}`)
  return steps
}

export function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function apply(stream: unknown[], step: Step): unknown[] {
  const out: unknown[] = []
  for (const v of stream) {
    if (step.kind === 'key') {
      if (typeOf(v) !== 'object') fail(`cannot index ${typeOf(v)} with "${step.name}"`)
      out.push((v as Record<string, unknown>)[step.name] ?? null)
    } else if (step.kind === 'index') {
      if (!Array.isArray(v)) fail(`cannot index ${typeOf(v)} with [${step.i}]`)
      out.push(v[step.i] ?? null)
    } else {
      if (Array.isArray(v)) out.push(...v)
      else if (typeOf(v) === 'object') out.push(...Object.values(v as object))
      else fail(`cannot iterate ${typeOf(v)} with []`)
    }
  }
  return out
}

export function runQuery(root: unknown, path: string | undefined): unknown {
  let stream: unknown[] = [root]
  for (const step of parsePath(path ?? '.')) stream = apply(stream, step)
  // Collapse the stream: a single value stays scalar; many become an array.
  return stream.length === 1 ? stream[0] : stream
}

// --shape: compact structural summary so an agent never has to cat the file.
function shapeOf(v: unknown, depth = 0): string {
  const t = typeOf(v)
  if (t === 'array') {
    const arr = v as unknown[]
    if (arr.length === 0) return 'array(0)'
    return `array(${arr.length}) of ${shapeOf(arr[0], depth + 1)}`
  }
  if (t === 'object') {
    if (depth > 3) return 'object'
    const entries = Object.entries(v as Record<string, unknown>)
    const shown = entries.slice(0, 12)
    const body = shown.map(([k, val]) => `${k}: ${shapeOf(val, depth + 1)}`).join(', ')
    const more = entries.length > shown.length ? `, …+${entries.length - shown.length}` : ''
    return `{${body}${more}}`
  }
  if (t === 'string') {
    const s = v as string
    return s.length > 24 ? `string("${s.slice(0, 21)}…")` : `string("${s}")`
  }
  return t
}

// Project each row down to the picked fields (--pick 'a,b,c').
// Fields may be dot paths: --pick 'customer.country,total'.
function pick(result: unknown, spec: string): unknown {
  const fields = spec
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
  const dig = (row: unknown, path: string): unknown => {
    let v: unknown = row
    for (const key of path.split('.')) {
      if (v === null || typeof v !== 'object') return null
      v = (v as Record<string, unknown>)[key] ?? null
    }
    return v
  }
  const project = (row: unknown) => {
    if (typeOf(row) !== 'object') return row
    if (fields.length === 1) return dig(row, fields[0]!)
    return Object.fromEntries(fields.map((f) => [f, dig(row, f)]))
  }
  return Array.isArray(result) ? result.map(project) : project(result)
}

// TSV for uniform rows: keys once in a header, values per line. Token-cheap
// and pipeable into awk/sort.
export function toTsv(result: unknown): string[] {
  const arr = Array.isArray(result) ? result : [result]
  if (arr.length === 0) return []
  const cell = (v: unknown) =>
    v === null || v === undefined
      ? ''
      : typeOf(v) === 'object' || Array.isArray(v)
        ? JSON.stringify(v)
        : String(v).replace(/[\t\n]/g, ' ')
  if (typeOf(arr[0]) !== 'object') return arr.map(cell)
  const headers = Object.keys(arr[0] as object)
  return [
    headers.join('\t'),
    ...arr.map((row) => headers.map((h) => cell((row as Record<string, unknown>)[h])).join('\t')),
  ]
}

// Shared output handling for the query commands.
export async function emitQueryResult(
  result: unknown,
  flags: Record<string, string | boolean | undefined>
) {
  const opts = {
    limit: num(flags.limit, 50),
    all: flags.all === true,
    budget: num(flags.budget, 0),
  }

  if (flags.shape) return void process.stdout.write(shapeOf(result) + '\n')

  if (typeof flags.where === 'string') {
    if (!Array.isArray(result)) fail('--where needs an array result', 'iterate with [] first')
    const rows = result as unknown[]
    const filtered = rows.filter(compileWhere(flags.where))
    if (rows.length > 0 && filtered.length === 0) {
      process.stderr.write(
        `ax: note: 0 of ${rows.length} rows matched --where — if comparing to a string, quote it: --where "plan == 'pro'"\n`
      )
    }
    result = filtered
  }

  if (typeof flags.pick === 'string') result = pick(result, flags.pick)

  // --like: rank array items by semantic similarity to a query.
  if (typeof flags.like === 'string') {
    if (!Array.isArray(result)) fail('--like needs an array result', 'iterate with [] first')
    const { rankBySimilarity } = await import('./embed')
    const strings = result.map((v) =>
      typeOf(v) === 'object' || Array.isArray(v) ? JSON.stringify(v) : String(v)
    )
    const ranked = await rankBySimilarity(flags.like, strings)
    const minScore = typeof flags.min === 'string' ? Number(flags.min) : -Infinity
    emitLines(
      ranked.filter((r) => r.score >= minScore).map((r) => `${r.score.toFixed(3)}  ${r.line}`),
      opts
    )
    process.exit(0)
  }

  // --freq: frequency table of the (picked) values — sort | uniq -c | sort -rn.
  if (flags.freq) {
    const arr = Array.isArray(result) ? result : [result]
    const counts = new Map<string, number>()
    for (const v of arr) {
      const key = typeOf(v) === 'object' || Array.isArray(v) ? JSON.stringify(v) : String(v)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const lines = [...counts.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([v, n]) => `${String(n).padStart(7)}  ${v}`)
    return emitLines(lines, opts)
  }

  if (flags.tsv) return emitLines(toTsv(result), opts)

  if (flags.keys) {
    const keys = Array.isArray(result)
      ? result.map((_, i) => String(i))
      : typeOf(result) === 'object'
        ? Object.keys(result as object)
        : fail(`cannot list keys of ${typeOf(result)}`)
    return emitLines(keys, opts)
  }

  if (flags.len) {
    const len = Array.isArray(result)
      ? result.length
      : typeOf(result) === 'object'
        ? Object.keys(result as object).length
        : typeof result === 'string'
          ? result.length
          : fail(`cannot take length of ${typeOf(result)}`)
    return void process.stdout.write(len + '\n')
  }

  if (flags.raw) {
    const arr = Array.isArray(result) ? result : [result]
    const lines = arr.map((v) =>
      typeOf(v) === 'object' || Array.isArray(v) ? JSON.stringify(v) : String(v)
    )
    return emitLines(lines, opts)
  }

  return emitJson(result, opts)
}

export const queryFlagDefs = {
  keys: { type: 'boolean' },
  len: { type: 'boolean' },
  raw: { type: 'boolean' },
  all: { type: 'boolean' },
  help: { type: 'boolean' },
  fresh: { type: 'boolean' },
  shape: { type: 'boolean' },
  freq: { type: 'boolean' },
  tsv: { type: 'boolean' },
  limit: { type: 'string' },
  where: { type: 'string' },
  pick: { type: 'string' },
  budget: { type: 'string' },
  like: { type: 'string' },
  min: { type: 'string' },
} as const
