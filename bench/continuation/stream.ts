export type NormalizedToolCall = {
  ordinal: number
  name: string
  input: Record<string, unknown>
  resultText: string
  isError: boolean
}

export type RunMetrics = {
  durationMs: number
  turns: number
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export type NormalizedRun =
  | {
      status: 'complete'
      issues: []
      finalText: string
      toolCalls: NormalizedToolCall[]
      metrics: RunMetrics
    }
  | {
      status: 'not_gradable'
      issues: string[]
      finalText: null
      toolCalls: NormalizedToolCall[]
      metrics: null
    }

type PendingToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
  resultText?: string
  isError?: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function notGradable(issues: string[], toolCalls: NormalizedToolCall[] = []): NormalizedRun {
  return {
    status: 'not_gradable',
    issues: [...new Set(issues)],
    finalText: null,
    toolCalls,
    metrics: null,
  }
}

function completedTools(pending: PendingToolCall[]): NormalizedToolCall[] {
  return pending.flatMap((call, index) =>
    call.resultText === undefined || call.isError === undefined
      ? []
      : [
          {
            ordinal: index + 1,
            name: call.name,
            input: call.input,
            resultText: call.resultText,
            isError: call.isError,
          },
        ]
  )
}

export function normalizeClaudeStream(rawJsonl: string): NormalizedRun {
  const events: Record<string, unknown>[] = []
  for (const line of rawJsonl
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)) {
    try {
      const event = record(JSON.parse(line))
      if (!event) return notGradable(['unsupported stream event shape'])
      events.push(event)
    } catch {
      return notGradable(['invalid stream JSON'])
    }
  }

  const pending: PendingToolCall[] = []
  const byId = new Map<string, PendingToolCall>()
  const unmatchedResultIds: string[] = []
  const terminals: Record<string, unknown>[] = []
  const issues: string[] = []

  for (const event of events) {
    if (event.type === 'system') continue
    if (event.type === 'result') {
      terminals.push(event)
      continue
    }
    if (event.type !== 'assistant' && event.type !== 'user') {
      issues.push('unsupported stream event shape')
      continue
    }
    const message = record(event.message)
    if (!message || !Array.isArray(message.content)) {
      issues.push('unsupported stream event shape')
      continue
    }
    for (const item of message.content) {
      const block = record(item)
      if (!block || (block.type !== 'tool_use' && block.type !== 'tool_result')) continue
      if (block.type === 'tool_use') {
        const input = record(block.input)
        if (typeof block.id !== 'string' || typeof block.name !== 'string' || !input) {
          issues.push('unsupported stream event shape')
          continue
        }
        if (byId.has(block.id)) {
          issues.push('duplicate tool use id')
          continue
        }
        const call = { id: block.id, name: block.name, input }
        pending.push(call)
        byId.set(block.id, call)
        continue
      }
      if (
        typeof block.tool_use_id !== 'string' ||
        typeof block.content !== 'string' ||
        typeof block.is_error !== 'boolean'
      ) {
        issues.push('unsupported stream event shape')
        continue
      }
      const call = byId.get(block.tool_use_id)
      if (!call) {
        unmatchedResultIds.push(block.tool_use_id)
        continue
      }
      if (call.resultText !== undefined) {
        issues.push('unmatched tool result')
        continue
      }
      call.resultText = block.content
      call.isError = block.is_error
    }
  }

  const precededIds = new Set(unmatchedResultIds.filter((id) => byId.has(id)))
  if (precededIds.size > 0) issues.push('tool result preceded tool use')
  if (unmatchedResultIds.some((id) => !byId.has(id))) issues.push('unmatched tool result')
  if (pending.some((call) => call.resultText === undefined && !precededIds.has(call.id))) {
    issues.push('missing tool result')
  }
  const toolCalls = completedTools(pending)
  if (terminals.length === 0) issues.push('missing terminal result')
  if (terminals.length > 1) issues.push('multiple terminal results')
  const terminal = terminals[0]
  if (terminal && (terminal.subtype !== 'success' || terminal.is_error !== false)) {
    issues.push('terminal result was not successful')
  }
  if (terminal && typeof terminal.result !== 'string') {
    issues.push('terminal result text missing')
  }
  const usage = record(terminal?.usage)
  const metricValues = [
    terminal?.duration_ms,
    terminal?.num_turns,
    terminal?.total_cost_usd,
    usage?.input_tokens,
    usage?.output_tokens,
    usage?.cache_creation_input_tokens,
    usage?.cache_read_input_tokens,
  ]
  if (
    terminal &&
    metricValues.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  ) {
    issues.push('terminal metrics missing')
  }
  if (issues.length > 0 || !terminal || !usage) return notGradable(issues, toolCalls)

  return {
    status: 'complete',
    issues: [],
    finalText: terminal.result as string,
    toolCalls,
    metrics: {
      durationMs: terminal.duration_ms as number,
      turns: terminal.num_turns as number,
      totalCostUsd: terminal.total_cost_usd as number,
      inputTokens: usage.input_tokens as number,
      outputTokens: usage.output_tokens as number,
      cacheCreationInputTokens: usage.cache_creation_input_tokens as number,
      cacheReadInputTokens: usage.cache_read_input_tokens as number,
    },
  }
}
