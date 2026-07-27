export type StreamShapeSummary = {
  type: string | null
  count: number
  paths: string[]
}

function kind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function childPath(path: string, key: string): string {
  if (path === 'modelUsage') return 'modelUsage.<model>'
  return path ? `${path}.${key}` : key
}

function collectPaths(value: unknown, path: string, paths: Set<string>): void {
  paths.add(`${path || '$'}:${kind(value)}`)
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, `${path || '$'}[]`, paths)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectPaths(child, childPath(path, key), paths)
    }
  }
}

export function inspectStreamShapes(rawJsonl: string): StreamShapeSummary[] {
  const grouped = new Map<string, StreamShapeSummary>()
  for (const [index, rawLine] of rawJsonl.split('\n').entries()) {
    const line = rawLine.trim()
    if (!line) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error(`invalid stream JSON on line ${index + 1}`)
    }
    const paths = new Set<string>()
    collectPaths(event, '', paths)
    const type =
      event &&
      typeof event === 'object' &&
      typeof (event as Record<string, unknown>).type === 'string'
        ? String((event as Record<string, unknown>).type)
        : null
    const key = type ?? '<null>'
    const current = grouped.get(key) ?? { type, count: 0, paths: [] }
    current.count++
    current.paths = [...new Set([...current.paths, ...paths])].sort()
    grouped.set(key, current)
  }
  return [...grouped.values()].sort((left, right) =>
    String(left.type).localeCompare(String(right.type))
  )
}

if (import.meta.main) {
  const path = process.argv[2]
  if (!path) throw new Error('stream JSONL path is required')
  console.log(JSON.stringify(inspectStreamShapes(await Bun.file(path).text()), null, 2))
}
