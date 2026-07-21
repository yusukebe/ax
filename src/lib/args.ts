import { parseArgs as nodeParseArgs, type ParseArgsConfig } from 'util'

// Thin wrapper over the built-in util.parseArgs (Bun/Node standard).
// We only reshape its output to { _, flags } and stay non-strict so an
// unknown flag doesn't crash — it just gets ignored.
export type Options = NonNullable<ParseArgsConfig['options']>

export function parseArgs(argv: string[], options: Options) {
  const { values, positionals } = nodeParseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: false,
  })
  // Unknown flags are ignored by non-strict parsing — but ignoring them
  // silently costs an agent a whole retry turn. Warn with a suggestion.
  const known = Object.keys(options)
  for (const key of Object.keys(values)) {
    if (known.includes(key)) continue
    const isLong = argv.some((arg) => arg === `--${key}` || arg.startsWith(`--${key}=`))
    const flag = `${isLong ? '--' : '-'}${key}`
    // Suggest only near-certain matches (shared 2-char prefix or containment).
    const guess = isLong
      ? known.find((k) => k.startsWith(key.slice(0, 2)) || k.includes(key) || key.includes(k))
      : undefined
    process.stderr.write(
      `ax: note: unknown flag ${flag} ignored${guess ? ` (did you mean --${guess}?)` : ''} — see --help\n`
    )
  }
  return { _: positionals, flags: values as Record<string, string | boolean | undefined> }
}

export function num(v: string | boolean | undefined, fallback: number): number {
  if (typeof v !== 'string') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
