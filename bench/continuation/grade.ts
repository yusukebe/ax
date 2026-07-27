import type { IncidentRecord } from './fixture'
import { hasOverlappingInvocations, type AxInvocation } from './telemetry'

export type AnswerGrade = {
  exact: boolean
  schemaValid: boolean
  missingIds: string[]
  unexpectedIds: string[]
  duplicateIds: string[]
  outOfOrderIds: string[]
  fieldMismatchIds: string[]
}

export type ProtocolGrade = {
  status: 'pass' | 'fail' | 'not_gradable'
  issues: string[]
  pageCount: number
}

export type AdoptionGrade = {
  adoptedEnvelope: boolean
  validChain: boolean
  budgetCompliant: boolean
  alternativeStrategy:
    | 'offset-without-envelope'
    | 'all'
    | 'limit-bypass'
    | 'plain-ax'
    | 'no-instrumented-ax'
    | 'direct-fixture-read'
    | null
  finalAnswerExact: boolean | null
}

type Envelope = {
  data: unknown[]
  meta: {
    state: 'more' | 'complete' | 'past_end'
    offset: number
    returned: number
    next_offset: number | null
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}

function exactKeys(value: object, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function isIncidentRecord(value: unknown): value is IncidentRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    exactKeys(record, ['id', 'owner', 'severity', 'status']) &&
    typeof record.id === 'string' &&
    typeof record.owner === 'string' &&
    typeof record.severity === 'string' &&
    ['S1', 'S2', 'S3', 'S4'].includes(record.severity) &&
    typeof record.status === 'string' &&
    ['open', 'investigating', 'mitigated', 'closed'].includes(record.status)
  )
}

export function gradeAnswer(finalText: string, expected: IncidentRecord[]): AnswerGrade {
  let parsed: unknown
  try {
    parsed = JSON.parse(finalText)
  } catch {
    return {
      exact: false,
      schemaValid: false,
      missingIds: [],
      unexpectedIds: [],
      duplicateIds: [],
      outOfOrderIds: [],
      fieldMismatchIds: [],
    }
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !exactKeys(parsed, ['records']) ||
    !Array.isArray((parsed as { records?: unknown }).records) ||
    !(parsed as { records: unknown[] }).records.every(isIncidentRecord)
  ) {
    return {
      exact: false,
      schemaValid: false,
      missingIds: [],
      unexpectedIds: [],
      duplicateIds: [],
      outOfOrderIds: [],
      fieldMismatchIds: [],
    }
  }
  const actual = (parsed as { records: IncidentRecord[] }).records
  const expectedById = new Map(expected.map((record) => [record.id, record]))
  const actualIds = actual.map((record) => record.id)
  const expectedIds = expected.map((record) => record.id)
  const duplicateIds = unique(actualIds.filter((id, index) => actualIds.indexOf(id) !== index))
  const missingIds = expectedIds.filter((id) => !actualIds.includes(id))
  const unexpectedIds = unique(actualIds.filter((id) => !expectedById.has(id)))
  const duplicateSet = new Set(duplicateIds)
  const comparableActualIds = actualIds.filter(
    (id) => expectedById.has(id) && !duplicateSet.has(id)
  )
  const comparableIdSet = new Set(comparableActualIds)
  const comparableExpectedIds = expectedIds.filter((id) => comparableIdSet.has(id))
  const outOfOrderIds = unique(
    comparableActualIds.filter((id, index) => id !== comparableExpectedIds[index])
  )
  const fieldMismatchIds = unique(
    actual
      .filter((record) => {
        const wanted = expectedById.get(record.id)
        return (
          wanted !== undefined &&
          (record.owner !== wanted.owner ||
            record.severity !== wanted.severity ||
            record.status !== wanted.status)
        )
      })
      .map((record) => record.id)
  )
  const exact =
    actual.length === expected.length &&
    missingIds.length === 0 &&
    unexpectedIds.length === 0 &&
    duplicateIds.length === 0 &&
    outOfOrderIds.length === 0 &&
    fieldMismatchIds.length === 0
  return {
    exact,
    schemaValid: true,
    missingIds,
    unexpectedIds,
    duplicateIds,
    outOfOrderIds,
    fieldMismatchIds,
  }
}

function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, index) => {
    if (arg === flag && argv[index + 1]) return [argv[index + 1]!]
    if (arg.startsWith(`${flag}=`)) return [arg.slice(flag.length + 1)]
    return []
  })
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
}

function fixtureCalls(invocations: AxInvocation[]): AxInvocation[] {
  return invocations.filter((call) =>
    call.argv.some((arg) => arg === 'continuation.html' || arg.endsWith('/continuation.html'))
  )
}

function extractionCalls(invocations: AxInvocation[]): AxInvocation[] {
  return fixtureCalls(invocations).filter(
    (call) =>
      !call.argv.includes('--count') &&
      !call.argv.includes('--outline') &&
      !call.argv.includes('--locate')
  )
}

function stableCommand(argv: string[]): string {
  const stable: string[] = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--offset') {
      index++
      continue
    }
    if (argv[index]!.startsWith('--offset=')) continue
    stable.push(argv[index]!)
  }
  return JSON.stringify(stable)
}

function parseEnvelope(call: AxInvocation): Envelope | null {
  try {
    const value = JSON.parse(call.stdout) as Envelope
    if (
      !value ||
      !Array.isArray(value.data) ||
      !value.meta ||
      !['more', 'complete', 'past_end'].includes(value.meta.state) ||
      !Number.isInteger(value.meta.offset) ||
      !Number.isInteger(value.meta.returned) ||
      !(value.meta.next_offset === null || Number.isInteger(value.meta.next_offset))
    ) {
      return null
    }
    return value
  } catch {
    return null
  }
}

export function gradeProtocol(invocations: AxInvocation[], budget: number): ProtocolGrade {
  const fixture = fixtureCalls(invocations)
  if (fixture.length === 0) {
    return {
      status: 'not_gradable',
      issues: ['no instrumented fixture calls'],
      pageCount: 0,
    }
  }
  const issues: string[] = []
  if (fixture.some((call) => call.argv.includes('--all'))) issues.push('--all bypass')
  if (fixture.some((call) => hasFlag(call.argv, '--limit'))) {
    issues.push('--limit is forbidden')
  }
  if (hasOverlappingInvocations(fixture)) {
    return {
      status: 'not_gradable',
      issues: unique([...issues, 'overlapping fixture calls']),
      pageCount: 0,
    }
  }
  const calls = extractionCalls(invocations)
  if (calls.length === 0) {
    return {
      status: 'fail',
      issues: unique([...issues, 'no continuation extraction calls']),
      pageCount: 0,
    }
  }
  const command = stableCommand(calls[0]!.argv)
  let expectedOffset = 0
  let terminal = false
  for (const call of calls) {
    const budgets = flagValues(call.argv, '--budget')
    if (budgets.length !== 1 || budgets[0] !== String(budget)) {
      issues.push('budget changed or missing')
    }
    if (call.argv.includes('--all')) issues.push('--all bypass')
    if (!call.argv.includes('--json-envelope')) {
      issues.push('missing --json-envelope')
      continue
    }
    if (stableCommand(call.argv) !== command) issues.push('command drift')
    if (terminal) issues.push('call after terminal state')
    const envelope = parseEnvelope(call)
    if (!envelope) {
      return {
        status: 'not_gradable',
        issues: unique([...issues, 'unparseable envelope']),
        pageCount: calls.length,
      }
    }
    const offsets = flagValues(call.argv, '--offset')
    const actualOffset = offsets.length === 0 ? 0 : Number(offsets[0])
    if (
      offsets.length > 1 ||
      !Number.isInteger(actualOffset) ||
      actualOffset !== expectedOffset ||
      envelope.meta.offset !== actualOffset
    ) {
      issues.push('offset chain mismatch')
    }
    if (envelope.meta.returned !== envelope.data.length) {
      issues.push('returned count mismatch')
    }
    if (envelope.meta.state === 'more') {
      const next = envelope.meta.next_offset
      if (
        envelope.meta.returned <= 0 ||
        next === null ||
        next <= actualOffset ||
        next !== actualOffset + envelope.meta.returned
      ) {
        if (envelope.meta.returned <= 0 || next === actualOffset) {
          issues.push('zero-progress page')
        }
        issues.push('invalid next_offset')
      } else {
        expectedOffset = next
      }
    } else {
      terminal = true
      const terminalFixtureIndex = fixture.indexOf(call)
      if (terminalFixtureIndex < fixture.length - 1) {
        issues.push('fixture call after terminal state')
      }
      if (envelope.meta.next_offset !== null) {
        issues.push('terminal next_offset must be null')
      }
      if (envelope.meta.state === 'past_end' && actualOffset === 0) {
        issues.push('past_end cannot start at offset zero')
      }
    }
  }
  if (!terminal) issues.push('missing terminal state')
  return {
    status: issues.length === 0 ? 'pass' : 'fail',
    issues: unique(issues),
    pageCount: calls.length,
  }
}

export function gradeAdoption(
  invocations: AxInvocation[],
  protocol: ProtocolGrade,
  budget: number,
  finalAnswerExact: boolean | null
): AdoptionGrade {
  const fixture = fixtureCalls(invocations)
  const calls = extractionCalls(invocations)
  const adoptedEnvelope = calls.some((call) => call.argv.includes('--json-envelope'))
  const validChain = protocol.status === 'pass'
  const nonEnvelopeCalls = calls.filter((call) => !call.argv.includes('--json-envelope'))
  const alternativeStrategy = validChain
    ? null
    : fixture.some((call) => call.argv.includes('--all'))
      ? 'all'
      : fixture.some((call) => hasFlag(call.argv, '--limit'))
        ? 'limit-bypass'
        : nonEnvelopeCalls.some((call) => flagValues(call.argv, '--offset').length > 0)
          ? 'offset-without-envelope'
          : nonEnvelopeCalls.length > 0
            ? 'plain-ax'
            : fixture.length === 0
              ? 'no-instrumented-ax'
              : null
  return {
    adoptedEnvelope,
    validChain,
    budgetCompliant:
      calls.length > 0 &&
      calls.every((call) => {
        const values = flagValues(call.argv, '--budget')
        return (
          values.length === 1 &&
          values[0] === String(budget) &&
          !call.argv.includes('--all') &&
          !hasFlag(call.argv, '--limit')
        )
      }),
    alternativeStrategy,
    finalAnswerExact,
  }
}
