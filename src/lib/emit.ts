// Output helpers. Default-cap large results so agents don't drown in tokens,
// but NEVER truncate silently — always note what was dropped on stderr.
const DEFAULT_LIMIT = 50
// Rough chars-per-token estimate for --budget (opts.budget is in tokens).
const CHARS_PER_TOKEN = 4

type EmitOpts = { limit?: number; all?: boolean; budget?: number; offset?: number }

type PageState = 'more' | 'complete' | 'past_end'

export type PageMeta = {
  state: PageState
  total: number
  offset: number
  returned: number
  nextOffset: number | null
}

type CapResult<T> = { shown: T[]; meta: PageMeta }

function cap<T>(items: T[], opts: EmitOpts, sizeOf: (item: T) => number): CapResult<T> {
  const total = items.length
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 0
  if (offset >= total && offset > 0) {
    return {
      shown: [],
      meta: { state: 'past_end', total, offset, returned: 0, nextOffset: null },
    }
  }
  let shown = offset > 0 ? items.slice(offset) : items
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
  const returned = shown.length
  const nextOffset = offset + returned < total ? offset + returned : null
  return {
    shown,
    meta: {
      state: nextOffset === null ? 'complete' : 'more',
      total,
      offset,
      returned,
      nextOffset,
    },
  }
}

// Truncation is never silent — and the note names the exact --offset to
// continue from, so a follow-up call fetches only what wasn't shown instead
// of re-emitting everything under a bigger budget.
function note(meta: PageMeta) {
  if (meta.state === 'past_end') {
    process.stderr.write(
      `ax: note: --offset is past the end — only ${meta.total} result(s) exist\n`
    )
    return
  }
  if (meta.state === 'more') {
    const hidden = meta.total - meta.offset - meta.returned
    process.stderr.write(
      `ax: note: ${hidden} more result(s) hidden — continue with --offset ${meta.nextOffset} (or --all, --limit N, --budget T)\n`
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

// process.exit() discards stdout data still sitting in the write queue —
// when stdout is a pipe, anything past the 64KB kernel buffer is silently
// dropped. Every stdout write followed by an explicit exit must be awaited
// through this, so `ax … --body | jq` gets the whole body. (Parse mode
// exits naturally, so its writes drain on their own.)
export function writeStdoutFlushed(data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => process.stdout.write(data, () => resolve()))
}

export function emitLines(items: string[], opts: EmitOpts = {}) {
  const r = cap(items, opts, (s) => s.length + 1)
  let stripped = 0
  const safe = r.shown.map((line) => {
    const { text, removed } = sanitizeLine(line)
    stripped += removed
    return text
  })
  if (safe.length) process.stdout.write(safe.join('\n') + '\n')
  if (stripped > 0) {
    process.stderr.write(`ax: note: stripped ${stripped} control character(s) from output\n`)
  }
  note(r.meta)
}

export function emitJson(value: unknown, opts: EmitOpts = {}) {
  if (Array.isArray(value)) {
    const r = cap(value, opts, (v) => JSON.stringify(v).length + 4)
    process.stdout.write(JSON.stringify(r.shown, null, 2) + '\n')
    note(r.meta)
  } else {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  }
}

export function emitJsonEnvelope(value: unknown[], opts: EmitOpts = {}) {
  const r = cap(value, opts, (v) => JSON.stringify(v).length + 4)
  process.stdout.write(JSON.stringify({ data: r.shown, meta: r.meta }, null, 2) + '\n')
}
