// Output helpers. Default-cap large results so agents don't drown in tokens,
// but NEVER truncate silently — always note what was dropped on stderr.
const DEFAULT_LIMIT = 50
// Rough chars-per-token estimate for --budget (opts.budget is in tokens).
const CHARS_PER_TOKEN = 4

type EmitOpts = { limit?: number; all?: boolean; budget?: number }

function cap<T>(items: T[], opts: EmitOpts, sizeOf: (item: T) => number) {
  let shown = items
  if (!opts.all) {
    const limit = opts.limit ?? DEFAULT_LIMIT
    if (shown.length > limit) shown = shown.slice(0, limit)
  }
  // --budget <tokens>: additionally cut to an estimated token budget.
  if (opts.budget && opts.budget > 0) {
    const maxChars = opts.budget * CHARS_PER_TOKEN
    let used = 0
    let i = 0
    for (; i < shown.length; i++) {
      used += sizeOf(shown[i]!)
      if (used > maxChars && i > 0) break
    }
    shown = shown.slice(0, i)
  }
  return { shown, dropped: items.length - shown.length }
}

function note(dropped: number) {
  if (dropped > 0) {
    process.stderr.write(
      `ax: note: ${dropped} more result(s) hidden (use --all, --limit N, or --budget T)\n`
    )
  }
}

// Untrusted HTML can smuggle ANSI escapes / OSC sequences (terminal title
// changes, OSC 52 clipboard writes, cursor tricks) into extracted text.
// Strip every control char except \t and \n from line output — and, per
// ax's never-silent rule, say so when something was removed. JSON output
// is already safe (JSON.stringify escapes control chars).
// Whole sequences first (OSC then CSI then two-byte escapes), so no
// printable payload like "[31m" or "]0;title" is left behind; then any
// stray control bytes.
const OSC_SEQ = new RegExp('\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?', 'g')
const CSI_SEQ = new RegExp('\\x1b\\[[0-9;:?]*[ -/]*[@-~]?', 'g')
const ESC_SEQ = new RegExp('\\x1b.?', 'g')
const CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F\\u0080-\\u009F]', 'g')

export function sanitizeLine(s: string): { text: string; removed: number } {
  const text = s
    .replace(OSC_SEQ, '')
    .replace(CSI_SEQ, '')
    .replace(ESC_SEQ, '')
    .replace(CONTROL_CHARS, '')
  return { text, removed: s.length - text.length }
}

export function emitLines(items: string[], opts: EmitOpts = {}) {
  const { shown, dropped } = cap(items, opts, (s) => s.length + 1)
  let stripped = 0
  const safe = shown.map((line) => {
    const { text, removed } = sanitizeLine(line)
    stripped += removed
    return text
  })
  if (safe.length) process.stdout.write(safe.join('\n') + '\n')
  if (stripped > 0) {
    process.stderr.write(`ax: note: stripped ${stripped} control character(s) from output\n`)
  }
  note(dropped)
}

export function emitJson(value: unknown, opts: EmitOpts = {}) {
  if (Array.isArray(value)) {
    const { shown, dropped } = cap(value, opts, (v) => JSON.stringify(v).length + 4)
    process.stdout.write(JSON.stringify(shown, null, 2) + '\n')
    note(dropped)
  } else {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  }
}
