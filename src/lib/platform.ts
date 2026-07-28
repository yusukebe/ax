// Host-dependent primitives. This is the Bun/Node implementation — the one the
// repo runs and tests against. `platform.scriptc.ts` is the reduced
// counterpart a compiled binary gets; scripts/build-scriptc.ts substitutes it
// at build time, because scriptc refuses the calls used here at COMPILE time
// (no runtime branch could avoid them) and offers no dynamic escape hatch:
// `fetch`, `globalThis` and `process` cannot be aliased into an `any` value.
//
// Keep the two files' exported signatures identical.

/**
 * Decode bytes using a WHATWG encoding label.
 *
 * @returns The decoded text, or null when the host cannot handle the label.
 */
export function decodeText(bytes: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label).decode(bytes)
  } catch (e) {
    // Never crash a fetch over a bad charset claim — the caller falls back.
    if (e instanceof RangeError) return null
    throw e
  }
}

/**
 * Write to stdout and resolve once the data has actually been handed off.
 *
 * process.exit() discards stdout data still sitting in the write queue — when
 * stdout is a pipe, anything past the 64KB kernel buffer is silently dropped.
 */
export function writeStdout(data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => process.stdout.write(data, () => resolve()))
}
