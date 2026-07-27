import { expect, test } from 'bun:test'
import { auditToolContext } from './audit'
import type { AdoptionGrade } from './grade'
import type { NormalizedToolCall } from './stream'
import type { AxInvocation } from './telemetry'

function tool(name: string, input: Record<string, unknown>): NormalizedToolCall {
  return {
    ordinal: 1,
    name,
    input,
    resultText: '',
    isError: false,
  }
}

function bash(command: string): NormalizedToolCall {
  return tool('Bash', { command, description: 'synthetic' })
}

function invocation(argv: string[], start = 1): AxInvocation {
  return {
    argv,
    cwd: '/external/run/agent',
    stdout: '',
    stderr: '',
    exitCode: 0,
    startedAtMs: start,
    endedAtMs: start + 1,
  }
}

test('adoption grade can record direct fixture access', () => {
  const strategy: AdoptionGrade['alternativeStrategy'] = 'direct-fixture-read'
  expect(strategy).toBe('direct-fixture-read')
})

test.each([
  tool('Read', { file_path: '/external/run/agent/continuation.html' }),
  tool('Grep', { pattern: 'incident', path: 'continuation.html' }),
  tool('Glob', { pattern: '**/continuation.html', path: '.' }),
  tool('Grep', { pattern: 'incident', path: '.' }),
  tool('Grep', { pattern: 'incident' }),
  tool('Glob', { pattern: '**/*.html', path: '.' }),
])('%s directly accessing the fixture is a violation', (call) => {
  expect(auditToolContext([call], [])).toEqual({
    status: 'violation',
    issues: ['direct fixture access'],
    alternativeStrategy: 'direct-fixture-read',
  })
})

test.each([
  'cat continuation.html',
  'grep incident continuation.html',
  'python3 -c "open(\\"continuation.html\\")"',
  'f=continuation.html; cat "$f"',
  'cat *.html',
  'rg incident .',
  'ax continuation.html .incident --json-envelope; cat continuation.html',
])('%s is a direct fixture read violation', (command) => {
  expect(auditToolContext([bash(command)], [])).toEqual({
    status: 'violation',
    issues: ['direct fixture access'],
    alternativeStrategy: 'direct-fixture-read',
  })
})

test.each([
  tool('Grep', { pattern: 'incident', path: '/external/run/agent' }),
  bash('rg incident /external/run/agent'),
])('treats the known Agent directory as fixture-targeting', (call) => {
  expect(auditToolContext([call], [], 'continuation.html', '/external/run/agent')).toEqual({
    status: 'violation',
    issues: ['direct fixture access'],
    alternativeStrategy: 'direct-fixture-read',
  })
})

test('accepts a simple absolute shim command when telemetry matches', () => {
  const argv = ['continuation.html', '.incident', '--json-envelope']
  expect(
    auditToolContext(
      [bash('/external/run/bin/ax continuation.html .incident --json-envelope')],
      [invocation(argv)]
    )
  ).toEqual({
    status: 'pass',
    issues: [],
    alternativeStrategy: null,
  })
})

test.each([
  {
    name: 'semicolon',
    command:
      'ax continuation.html .incident --json-envelope; ' +
      'ax continuation.html .incident --json-envelope --offset 29',
    invocations: [
      invocation(['continuation.html', '.incident', '--json-envelope'], 1),
      invocation(['continuation.html', '.incident', '--json-envelope', '--offset', '29'], 3),
    ],
  },
  {
    name: 'and',
    command: 'ax continuation.html .incident --json-envelope && which ax',
    invocations: [invocation(['continuation.html', '.incident', '--json-envelope'])],
  },
])('$name-batched fixture ax command is not gradable', ({ command, invocations }) => {
  expect(auditToolContext([bash(command)], [...invocations])).toEqual({
    status: 'not_gradable',
    issues: ['unsupported fixture-targeting Bash command'],
    alternativeStrategy: null,
  })
})

test.each([
  'wrapper continuation.html',
  'ax continuation.html .incident --json-envelope | cat',
  'ax continuation.html .incident --json-envelope > /tmp/envelope.json',
  "python3 <<'PY'\nimport subprocess\nsubprocess.run(['ax', 'continuation.html'])\nPY",
  '$(command -v ax) continuation.html .incident --json-envelope',
  'ax continuation.html "unterminated',
])('%s is not gradable', (command) => {
  expect(auditToolContext([bash(command)], []).status).toBe('not_gradable')
})

test('ignores unsupported non-fixture discovery commands', () => {
  expect(auditToolContext([bash('command -v ax && ax --help | head -20')], [])).toEqual({
    status: 'pass',
    issues: [],
    alternativeStrategy: null,
  })
})

test.each([
  'python3 -c \'import glob; print(open(glob.glob("*.html")[0]).read())\'',
  'fixture-reader',
])('%s is not gradable without a proven-safe command shape', (command) => {
  expect(auditToolContext([bash(command)], [])).toEqual({
    status: 'not_gradable',
    issues: ['unverifiable non-ax Bash command'],
    alternativeStrategy: null,
  })
})

test('allows a non-file echo with arithmetic expansion', () => {
  expect(auditToolContext([bash('echo "Verification: $((1+1))"')], [])).toEqual({
    status: 'pass',
    issues: [],
    alternativeStrategy: null,
  })
})

test('rejects fixture metadata inspection outside ax', () => {
  expect(auditToolContext([bash('ls -la continuation.html && which ax')], [])).toEqual({
    status: 'violation',
    issues: ['fixture access outside ax'],
    alternativeStrategy: null,
  })
})

test('allows an unresolved ax path that never reached the shim', () => {
  const call = bash('./bin/ax continuation.html .incident --json-envelope')
  call.isError = true
  call.resultText = 'Exit code 127\n(eval):1: no such file or directory: ./bin/ax'
  expect(auditToolContext([call], [])).toEqual({
    status: 'pass',
    issues: [],
    alternativeStrategy: null,
  })
})

test.each([
  {
    name: 'missing telemetry',
    calls: [bash('ax continuation.html .incident --json-envelope')],
    invocations: [],
  },
  {
    name: 'extra telemetry',
    calls: [bash('ax continuation.html .incident --json-envelope')],
    invocations: [
      invocation(['continuation.html', '.incident', '--json-envelope'], 1),
      invocation(['continuation.html', '.incident', '--json-envelope', '--offset', '29'], 3),
    ],
  },
  {
    name: 'argv mismatch',
    calls: [bash('ax continuation.html .incident --json-envelope')],
    invocations: [invocation(['continuation.html', '.other', '--json-envelope'])],
  },
  {
    name: 'stream omits a fixture invocation',
    calls: [bash('ax --help')],
    invocations: [invocation(['continuation.html', '.incident', '--json-envelope'])],
  },
])('$name is not gradable', ({ calls, invocations }) => {
  expect(auditToolContext([...calls], [...invocations])).toEqual({
    status: 'not_gradable',
    issues: ['fixture ax telemetry mismatch'],
    alternativeStrategy: null,
  })
})
