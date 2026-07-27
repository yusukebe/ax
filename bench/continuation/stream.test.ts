import { expect, test } from 'bun:test'
import { normalizeClaudeStream } from './stream'

function assistantTool(id: string, command: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Bash',
          input: { command, description: 'synthetic command' },
        },
      ],
    },
  })
}

function userResult(id: string, content: string, isError = false): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
    tool_use_result: {
      stdout: content,
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    },
  })
}

function terminal(result: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    duration_ms: 1200,
    num_turns: 3,
    total_cost_usd: 0.125,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 13,
    },
  })
}

test('normalizes observed assistant tool use, user result, and terminal metrics', () => {
  const raw = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 10 }),
    assistantTool('tool-1', '/external/bin/ax continuation.html --json-envelope'),
    userResult('tool-1', '{"data":[],"meta":{"state":"complete"}}'),
    terminal('{"records":[]}'),
  ].join('\n')

  expect(normalizeClaudeStream(raw)).toEqual({
    status: 'complete',
    issues: [],
    finalText: '{"records":[]}',
    toolCalls: [
      {
        ordinal: 1,
        name: 'Bash',
        input: {
          command: '/external/bin/ax continuation.html --json-envelope',
          description: 'synthetic command',
        },
        resultText: '{"data":[],"meta":{"state":"complete"}}',
        isError: false,
      },
    ],
    metrics: {
      durationMs: 1200,
      turns: 3,
      totalCostUsd: 0.125,
      inputTokens: 11,
      outputTokens: 7,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 13,
    },
  })
})

function issues(raw: string): string[] {
  const normalized = normalizeClaudeStream(raw)
  expect(normalized.status).toBe('not_gradable')
  return normalized.issues
}

test.each([
  ['invalid JSON', '{', 'invalid stream JSON'],
  ['missing terminal', assistantTool('tool-1', 'ax --help'), 'missing terminal result'],
  ['multiple terminals', [terminal('{}'), terminal('{}')].join('\n'), 'multiple terminal results'],
  [
    'failed terminal',
    JSON.stringify({
      ...JSON.parse(terminal('{}')),
      subtype: 'error',
      is_error: true,
    }),
    'terminal result was not successful',
  ],
  [
    'duplicate tool id',
    [
      assistantTool('tool-1', 'ax --help'),
      assistantTool('tool-1', 'ax --version'),
      userResult('tool-1', 'ok'),
      terminal('{}'),
    ].join('\n'),
    'duplicate tool use id',
  ],
  [
    'unmatched tool result',
    [userResult('unknown', 'no match'), terminal('{}')].join('\n'),
    'unmatched tool result',
  ],
  [
    'missing tool result',
    [assistantTool('tool-1', 'ax --help'), terminal('{}')].join('\n'),
    'missing tool result',
  ],
  [
    'unsupported message shape',
    [JSON.stringify({ type: 'assistant', message: { content: 'text' } }), terminal('{}')].join(
      '\n'
    ),
    'unsupported stream event shape',
  ],
  [
    'missing result text',
    JSON.stringify({ ...JSON.parse(terminal('{}')), result: null }),
    'terminal result text missing',
  ],
  [
    'missing metrics',
    JSON.stringify({ ...JSON.parse(terminal('{}')), duration_ms: '1200' }),
    'terminal metrics missing',
  ],
] as const)('%s is not gradable', (_name, raw, issue) => {
  expect(issues(raw)).toContain(issue)
})

test('reports a tool result that precedes its tool use', () => {
  const raw = [
    userResult('tool-1', 'too early'),
    assistantTool('tool-1', 'ax --help'),
    terminal('{}'),
  ].join('\n')
  expect(issues(raw)).toContain('tool result preceded tool use')
})

test('rejects negative terminal metrics', () => {
  const event = JSON.parse(terminal('{}'))
  event.total_cost_usd = -1
  expect(issues(JSON.stringify(event))).toContain('terminal metrics missing')
})

test('ignores observed system, thinking, and text noise', () => {
  const raw = [
    JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 10 }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'synthetic' },
          { type: 'text', text: 'synthetic' },
        ],
      },
    }),
    terminal('{}'),
  ].join('\n')

  expect(normalizeClaudeStream(raw)).toMatchObject({
    status: 'complete',
    finalText: '{}',
    toolCalls: [],
  })
})
