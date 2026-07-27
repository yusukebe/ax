import { mkdir, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gradeRunRoot, type RunGrade } from './grade-run'
import type { AdoptionGrade, ProtocolGrade } from './grade'
import {
  assertExternalRunRoot,
  capturePilot,
  prepareRun,
  type Condition,
  type PreparedRun,
} from './run'

export const MATRIX_CONDITIONS: readonly Condition[] = [
  'conformance',
  'adoption-guided',
  'adoption-ablated',
  'conformance',
  'adoption-guided',
  'adoption-ablated',
  'conformance',
  'adoption-guided',
  'adoption-ablated',
]

export type PublicRunSummary = {
  run: number
  condition: Condition
  publicModel: 'Sonnet 5'
  answerExact: boolean
  schemaValid: boolean
  answerFailureModes: {
    schemaInvalid: boolean
    missingRecords: boolean
    unexpectedRecords: boolean
    duplicateRecords: boolean
    orderingErrors: boolean
    fieldMismatches: boolean
  }
  protocolStatus: ProtocolGrade['status']
  pageCount: number
  adoptedEnvelope: boolean | null
  validChain: boolean | null
  budgetCompliant: boolean | null
  alternativeStrategy: AdoptionGrade['alternativeStrategy'] | null
  turns: number
  durationMs: number
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export type MatrixSummary = {
  schemaVersion: 1
  publicModel: 'Sonnet 5'
  runs: PublicRunSummary[]
}

type MatrixStatus = {
  schemaVersion: 1
  state: 'running' | 'stopped' | 'complete'
  completedRuns: number
  stopReason?: 'claude_nonzero' | 'not_gradable' | 'condition_violation' | 'infrastructure_error'
}

export type MatrixDependencies = {
  prepare: (runRoot: string, condition: Condition) => Promise<PreparedRun>
  capture: (prepared: PreparedRun, model: string) => Promise<number>
  grade: (runRoot: string, condition: Condition) => Promise<RunGrade>
}

export type MatrixOptions = {
  matrixRoot: string
  model: string | undefined
  confirmation: string | undefined
  dependencies?: MatrixDependencies
}

const DEFAULT_DEPENDENCIES: MatrixDependencies = {
  prepare: prepareRun,
  capture: capturePilot,
  grade: gradeRunRoot,
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`
  await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, path)
}

function publicSummary(run: number, grade: RunGrade): PublicRunSummary {
  if (!grade.answer || !grade.metrics) throw new Error('gradable run is missing answer or metrics')
  const recordLevelFailuresKnown = grade.answer.schemaValid
  return {
    run,
    condition: grade.condition,
    publicModel: 'Sonnet 5',
    answerExact: grade.answer.exact,
    schemaValid: grade.answer.schemaValid,
    answerFailureModes: {
      schemaInvalid: !grade.answer.schemaValid,
      missingRecords: recordLevelFailuresKnown && grade.answer.missingIds.length > 0,
      unexpectedRecords: recordLevelFailuresKnown && grade.answer.unexpectedIds.length > 0,
      duplicateRecords: recordLevelFailuresKnown && grade.answer.duplicateIds.length > 0,
      orderingErrors: recordLevelFailuresKnown && grade.answer.outOfOrderIds.length > 0,
      fieldMismatches: recordLevelFailuresKnown && grade.answer.fieldMismatchIds.length > 0,
    },
    protocolStatus: grade.protocol.status,
    pageCount: grade.protocol.pageCount,
    adoptedEnvelope: grade.adoption?.adoptedEnvelope ?? null,
    validChain: grade.adoption?.validChain ?? null,
    budgetCompliant: grade.adoption?.budgetCompliant ?? null,
    alternativeStrategy: grade.adoption?.alternativeStrategy ?? null,
    turns: grade.metrics.turns,
    durationMs: grade.metrics.durationMs,
    totalCostUsd: grade.metrics.totalCostUsd,
    inputTokens: grade.metrics.inputTokens,
    outputTokens: grade.metrics.outputTokens,
    cacheCreationInputTokens: grade.metrics.cacheCreationInputTokens,
    cacheReadInputTokens: grade.metrics.cacheReadInputTokens,
  }
}

export async function runMatrix(options: MatrixOptions): Promise<MatrixSummary> {
  if (options.confirmation !== '9') {
    throw new Error('exactly 9 paid runs require --confirm-paid-runs=9')
  }
  if (!options.model) throw new Error('AX_BENCH_MODEL is required')
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const matrixRoot = await assertExternalRunRoot(repoRoot, options.matrixRoot)
  await mkdir(matrixRoot, { recursive: false })
  const summary: MatrixSummary = { schemaVersion: 1, publicModel: 'Sonnet 5', runs: [] }
  const statusPath = join(matrixRoot, 'matrix-status.json')
  let stopped = false
  const writeStopped = async (stopReason: NonNullable<MatrixStatus['stopReason']>) => {
    await writeJsonAtomic(statusPath, {
      schemaVersion: 1,
      state: 'stopped',
      completedRuns: summary.runs.length,
      stopReason,
    } satisfies MatrixStatus)
    stopped = true
  }

  try {
    await writeJsonAtomic(statusPath, {
      schemaVersion: 1,
      state: 'running',
      completedRuns: 0,
    } satisfies MatrixStatus)
    for (const [index, condition] of MATRIX_CONDITIONS.entries()) {
      const runNumber = index + 1
      const runRoot = join(matrixRoot, `run-${String(runNumber).padStart(2, '0')}`)
      const prepared = await dependencies.prepare(runRoot, condition)
      const exitCode = await dependencies.capture(prepared, options.model)
      if (exitCode !== 0) {
        await writeStopped('claude_nonzero')
        throw new Error('Claude capture exited non-zero')
      }
      const grade = await dependencies.grade(runRoot, condition)
      if (grade.condition !== condition) {
        await writeStopped('not_gradable')
        throw new Error('grade condition mismatch')
      }
      if (grade.evidenceStatus !== 'gradable') {
        await writeStopped(grade.evidenceStatus)
        throw new Error(`matrix stopped: ${grade.evidenceStatus}`)
      }
      summary.runs.push(publicSummary(runNumber, grade))
      await writeJsonAtomic(join(matrixRoot, 'summary.json'), summary)
      await writeJsonAtomic(statusPath, {
        schemaVersion: 1,
        state: 'running',
        completedRuns: summary.runs.length,
      } satisfies MatrixStatus)
    }
    await writeJsonAtomic(statusPath, {
      schemaVersion: 1,
      state: 'complete',
      completedRuns: summary.runs.length,
    } satisfies MatrixStatus)
  } catch (error) {
    if (!stopped) await writeStopped('infrastructure_error')
    throw error
  }
  return summary
}

if (import.meta.main) {
  const [matrixRoot, ...flags] = process.argv.slice(2)
  if (!matrixRoot) throw new Error('matrix-root is required')
  const confirmation = flags
    .find((flag) => flag.startsWith('--confirm-paid-runs='))
    ?.slice('--confirm-paid-runs='.length)
  const summary = await runMatrix({
    matrixRoot,
    model: process.env.AX_BENCH_MODEL,
    confirmation,
  })
  console.log(
    JSON.stringify(
      {
        completedRuns: summary.runs.length,
        matrixRoot: resolve(matrixRoot),
        summaryPath: resolve(matrixRoot, 'summary.json'),
      },
      null,
      2
    )
  )
}
