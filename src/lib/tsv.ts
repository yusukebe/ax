// TSV rendering for the CLI's extraction paths, split out of query.ts so the
// compiled module graph does not pull in the (currently unwired) jq surface.
//
// Rows are typed concretely rather than over `unknown`: indexing a
// `Record<string, unknown>` has no scriptc lowering, so the generic renderer in
// query.ts — which runs only under Bun — cannot be shared here.
export type Row = Record<string, string | null>

function cell(v: string | null): string {
  if (v === null) return ''
  return v.replace(/[\t\n]/g, ' ')
}

/**
 * Render rows as TSV: keys once in a header line, values per row.
 *
 * @param rows - Uniform rows; the first row's keys become the header.
 * @returns One string per output line, header included.
 *
 * @example
 * toTsv([{ name: 'a', href: null }]) // => ['name\thref', 'a\t']
 */
export function toTsv(rows: Row[]): string[] {
  if (rows.length === 0) return []
  const headers: string[] = []
  for (const k in rows[0]!) headers.push(k)
  const lines: string[] = [headers.join('\t')]
  for (const row of rows) {
    const rec: any = row
    lines.push(
      headers
        .map((h) => {
          // A dynamic read: an index-signature read is typed `| undefined`
          // under noUncheckedIndexedAccess, which has no keyed-read lowering.
          const v = (rec[h] ?? null) as string | null
          return cell(v)
        })
        .join('\t')
    )
  }
  return lines
}
