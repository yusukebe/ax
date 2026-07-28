// The compiled-binary counterpart of platform.ts, substituted by
// scripts/build-scriptc.ts. Both files must export the same signatures.
//
// Two capabilities shrink here, and neither can be recovered at runtime:
//
//   * `new TextDecoder(label)` has no scriptc lowering beyond the default
//     utf-8, so decoding goes through Buffer's encodings. That covers UTF-8,
//     both UTF-16 byte orders and latin1; legacy codecs (shift_jis, euc-jp,
//     windows-125x, gbk, …) are outside Buffer's set and report unsupported,
//     which makes the caller fall back to UTF-8 with a note.
//   * process.stdout.write lowers only for a single string argument, so there
//     is no completion callback and no byte writes. A compiled binary writes
//     straight to the fd, leaving no userland queue to drain; byte payloads
//     are decoded as UTF-8, which is lossy for genuinely binary bodies (-o
//     writes those untouched).

function bufferEncodingFor(label: string): BufferEncoding | null {
  const l = label.toLowerCase()
  if (l === 'utf-8' || l === 'utf8') return 'utf8'
  if (l === 'utf-16le' || l === 'utf-16' || l === 'utf16le') return 'utf16le'
  if (l === 'latin1' || l === 'iso-8859-1' || l === 'ascii') return 'latin1'
  return null
}

/**
 * Decode bytes using a WHATWG encoding label.
 *
 * @returns The decoded text, or null when the label is outside Buffer's set.
 */
export function decodeText(bytes: Uint8Array, label: string): string | null {
  // UTF-16BE has no Buffer encoding — swap the pairs and decode as LE.
  if (label.toLowerCase() === 'utf-16be') {
    const swapped = new Uint8Array(bytes.length)
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      swapped[i] = bytes[i + 1]!
      swapped[i + 1] = bytes[i]!
    }
    return Buffer.from(swapped).toString('utf16le')
  }
  const encoding = bufferEncodingFor(label)
  if (encoding === 'utf16le') return Buffer.from(bytes).toString('utf16le')
  if (encoding === 'latin1') return Buffer.from(bytes).toString('latin1')
  if (encoding === 'utf8') return Buffer.from(bytes).toString('utf8')
  return null
}

/** Write to stdout. The fd write is synchronous, so there is nothing to await. */
export function writeStdout(data: string | Uint8Array): Promise<void> {
  process.stdout.write(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
  return Promise.resolve()
}
