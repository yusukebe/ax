export type AxInvocation = {
  argv: string[]
  cwd: string
  stdout: string
  stderr: string
  exitCode: number
  startedAtMs: number
  endedAtMs: number
}

export async function readAxTelemetry(path: string): Promise<AxInvocation[]> {
  const file = Bun.file(path)
  if (!(await file.exists())) return []
  const lines = (await file.text()).split('\n').filter(Boolean)
  const parsed = lines.map((line, index) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`invalid ax telemetry JSON on line ${index + 1}`)
    }
    const item = value as Partial<AxInvocation>
    if (
      !Array.isArray(item.argv) ||
      item.argv.some((arg) => typeof arg !== 'string') ||
      typeof item.cwd !== 'string' ||
      typeof item.stdout !== 'string' ||
      typeof item.stderr !== 'string' ||
      typeof item.exitCode !== 'number' ||
      typeof item.startedAtMs !== 'number' ||
      typeof item.endedAtMs !== 'number'
    ) {
      throw new Error(`invalid ax telemetry shape on line ${index + 1}`)
    }
    return item as AxInvocation
  })
  return parsed.sort((a, b) => a.startedAtMs - b.startedAtMs)
}

export function hasOverlappingInvocations(items: AxInvocation[]): boolean {
  return items.some((item, index) => index > 0 && item.startedAtMs < items[index - 1]!.endedAtMs)
}
