// A standalone replacement for util.parseArgs: scriptc has no lowering for it,
// and ax only needs the non-strict subset it was already configured with.
export type OptionDef = { type: 'boolean' | 'string'; short?: string; multiple?: boolean }
export type Options = Record<string, OptionDef>

export type FlagValue = string | boolean | string[] | undefined
export type Flags = Record<string, FlagValue>

function store(flags: Flags, def: OptionDef | undefined, key: string, value: string | boolean) {
  // `multiple: true` accumulates (-H can be repeated); everything else keeps
  // the last occurrence, matching util.parseArgs.
  if (def?.multiple === true) {
    const prev = flags[key]
    const list = Array.isArray(prev) ? prev : []
    list.push(String(value))
    flags[key] = list
    return
  }
  flags[key] = value
}

// Resolve a single-letter alias to its long name, or return null when the
// letter belongs to no declared option (non-strict: unknown flags are kept
// under their own name so the caller can warn about them).
function longNameOf(options: Options, short: string): string | null {
  for (const name in options) {
    if (options[name]?.short === short) return name
  }
  return null
}

/**
 * Parse `argv` into positionals and flags.
 *
 * Supports the surface ax uses: `--flag`, `--flag value`, `--flag=value`,
 * `-x value`, `-xvalue`, repeated flags via `multiple`, and `--` to end
 * option parsing. Unknown flags are accepted (never a hard error) so a typo
 * costs a warning rather than a failed run.
 *
 * @param argv - Arguments after the program name.
 * @param options - Declared options keyed by long name.
 * @returns `_` (positionals) and `flags` (parsed values).
 *
 * @example
 * parseArgs(['--md', '-H', 'a: b', 'x.html'], { md: { type: 'boolean' }, header: { type: 'string', short: 'H', multiple: true } })
 * // => { _: ['x.html'], flags: { md: true, header: ['a: b'] } }
 */
export function parseArgs(argv: string[], options: Options) {
  const positionals: string[] = []
  const flags: Flags = {}
  const unknown: string[] = []
  let i = 0
  let optionsEnded = false

  while (i < argv.length) {
    const arg = argv[i]!
    i++

    if (optionsEnded) {
      positionals.push(arg)
      continue
    }
    if (arg === '--') {
      optionsEnded = true
      continue
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      const key = eq === -1 ? body : body.slice(0, eq)
      const inline = eq === -1 ? null : body.slice(eq + 1)
      const def = options[key]
      if (!def) unknown.push(`--${key}`)
      // An undeclared flag has no type: an inline value makes it a string,
      // otherwise it reads as a boolean and never swallows the next argument.
      if (def?.type === 'string') {
        if (inline !== null) store(flags, def, key, inline)
        else if (i < argv.length) store(flags, def, key, argv[i++]!)
        else store(flags, def, key, true)
      } else {
        store(flags, def, key, inline ?? true)
      }
      continue
    }

    // A bare "-" is stdin, not a flag.
    if (arg.startsWith('-') && arg.length > 1) {
      // A short cluster ends as soon as a string-typed option claims the rest
      // of the token as its value (-mfoo), curl/getopt style.
      let j = 1
      while (j < arg.length) {
        const letter = arg.charAt(j)
        j++
        const key = longNameOf(options, letter)
        if (key === null) {
          unknown.push(`-${letter}`)
          store(flags, undefined, letter, true)
          continue
        }
        const def = options[key]!
        if (def.type !== 'string') {
          store(flags, def, key, true)
          continue
        }
        if (j < arg.length) {
          store(flags, def, key, arg.slice(j))
          j = arg.length
        } else if (i < argv.length) {
          store(flags, def, key, argv[i++]!)
        } else {
          store(flags, def, key, true)
        }
      }
      continue
    }

    positionals.push(arg)
  }

  // Ignoring an unknown flag silently costs an agent a whole retry turn.
  for (const flag of unknown) {
    const isLong = flag.startsWith('--')
    const key = isLong ? flag.slice(2) : flag.slice(1)
    // Suggest only near-certain matches (shared 2-char prefix or containment).
    let guess: string | undefined
    if (isLong) {
      for (const k in options) {
        if (k.startsWith(key.slice(0, 2)) || k.includes(key) || key.includes(k)) {
          guess = k
          break
        }
      }
    }
    process.stderr.write(
      `ax: note: unknown flag ${flag} ignored${guess ? ` (did you mean --${guess}?)` : ''} — see --help\n`
    )
  }

  return { _: positionals, flags }
}

type NumConstraint = {
  flag: string
  kind: 'positive integer' | 'non-negative integer' | 'positive number'
  fail: (message: string) => never
}

export function num(v: unknown, fallback: number, constraint?: NumConstraint): number {
  if (typeof v !== 'string') {
    if (constraint && v !== undefined) {
      constraint.fail(`${constraint.flag} expects a ${constraint.kind}, got no value`)
    }
    return fallback
  }
  const n = Number(v)
  if (constraint) {
    const valid =
      v.trim() !== '' &&
      Number.isFinite(n) &&
      (constraint.kind === 'positive number'
        ? n > 0
        : Number.isInteger(n) && (constraint.kind === 'positive integer' ? n > 0 : n >= 0))
    if (!valid) {
      constraint.fail(`${constraint.flag} expects a ${constraint.kind}, got "${v}"`)
    }
  }
  return Number.isFinite(n) ? n : fallback
}
