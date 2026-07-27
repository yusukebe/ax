import { join, resolve } from 'node:path'
import { auditToolContext, type ToolContextAudit } from './audit'
import { CONTINUATION_BUDGET, generateFixture } from './fixture'
import {
  gradeAdoption,
  gradeAnswer,
  gradeProtocol,
  type AdoptionGrade,
  type AnswerGrade,
  type ProtocolGrade,
} from './grade'
import { parseCondition, type Condition } from './run'
import { normalizeClaudeStream, type RunMetrics } from './stream'
import { readAxTelemetry } from './telemetry'

export type RunGrade = {
  evidenceStatus: 'gradable' | 'condition_violation' | 'not_gradable'
  condition: Condition
  answer: AnswerGrade | null
  protocol: ProtocolGrade
  adoption: AdoptionGrade | null
  access: ToolContextAudit
  metrics: RunMetrics | null
  issues: string[]
}

function calibratedProtocol(protocol: ProtocolGrade): ProtocolGrade {
  if (protocol.status === 'pass' && (protocol.pageCount < 3 || protocol.pageCount > 5)) {
    return {
      ...protocol,
      status: 'fail',
      issues: ['page count outside calibrated range'],
    }
  }
  return protocol
}

export async function gradeRunRoot(runRootInput: string, condition: Condition): Promise<RunGrade> {
  const runRoot = resolve(runRootInput)
  const [raw, invocations] = await Promise.all([
    Bun.file(join(runRoot, 'stream.jsonl')).text(),
    readAxTelemetry(join(runRoot, 'telemetry', 'ax.jsonl')),
  ])
  const normalized = normalizeClaudeStream(raw)
  const protocol = calibratedProtocol(gradeProtocol(invocations, CONTINUATION_BUDGET))
  const access = auditToolContext(
    normalized.toolCalls,
    invocations,
    'continuation.html',
    join(runRoot, 'agent')
  )
  const answer =
    normalized.status === 'complete'
      ? gradeAnswer(normalized.finalText, generateFixture().records)
      : null
  let adoption =
    condition === 'conformance'
      ? null
      : gradeAdoption(invocations, protocol, CONTINUATION_BUDGET, answer?.exact ?? null)
  if (adoption && access.status === 'violation') {
    adoption = { ...adoption, alternativeStrategy: 'direct-fixture-read' }
  }

  const evidenceStatus =
    normalized.status === 'not_gradable' || access.status === 'not_gradable'
      ? 'not_gradable'
      : access.status === 'violation'
        ? 'condition_violation'
        : protocol.status === 'not_gradable'
          ? 'not_gradable'
          : 'gradable'
  const issues = [
    ...(normalized.status === 'not_gradable' ? normalized.issues : []),
    ...(protocol.status === 'not_gradable' ? protocol.issues : []),
    ...(access.status === 'pass' ? [] : access.issues),
  ]

  return {
    evidenceStatus,
    condition,
    answer,
    protocol,
    adoption,
    access,
    metrics: normalized.metrics,
    issues: [...new Set(issues)],
  }
}

if (import.meta.main) {
  const [runRoot, conditionValue] = process.argv.slice(2)
  if (!runRoot) throw new Error('run-root is required')
  const condition = parseCondition(conditionValue)
  const grade = await gradeRunRoot(runRoot, condition)
  console.log(JSON.stringify(grade, null, 2))
  process.exit(
    grade.evidenceStatus === 'gradable' ? 0 : grade.evidenceStatus === 'condition_violation' ? 1 : 2
  )
}
