import { expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunGrade } from './grade-run'
import { MATRIX_CONDITIONS, runMatrix, type MatrixDependencies } from './matrix'
import type { Condition, PreparedRun } from './run'

function gradable(condition: Condition, run: number): RunGrade {
  const answerFailure = run === 1
  return {
    evidenceStatus: 'gradable',
    condition,
    answer: {
      exact: !answerFailure,
      schemaValid: !answerFailure,
      missingIds: answerFailure ? ['synthetic-missing'] : [],
      unexpectedIds: answerFailure ? ['synthetic-unexpected'] : [],
      duplicateIds: answerFailure ? ['synthetic-duplicate'] : [],
      outOfOrderIds: answerFailure ? ['synthetic-order'] : [],
      fieldMismatchIds: answerFailure ? ['synthetic-field'] : [],
    },
    protocol: { status: 'pass', issues: [], pageCount: 5 },
    adoption:
      condition === 'conformance'
        ? null
        : {
            adoptedEnvelope: true,
            validChain: true,
            budgetCompliant: true,
            alternativeStrategy: null,
            finalAnswerExact: true,
          },
    access: { status: 'pass', issues: [], alternativeStrategy: null },
    metrics: {
      durationMs: run * 100,
      turns: run,
      totalCostUsd: run / 100,
      inputTokens: run * 10,
      outputTokens: run * 5,
      cacheCreationInputTokens: run * 3,
      cacheReadInputTokens: run * 7,
    },
    issues: [],
  }
}

test('matrix uses the committed interleaved 3+3+3 order', () => {
  expect(MATRIX_CONDITIONS).toEqual([
    'conformance',
    'adoption-guided',
    'adoption-ablated',
    'conformance',
    'adoption-guided',
    'adoption-ablated',
    'conformance',
    'adoption-guided',
    'adoption-ablated',
  ])
})

test('matrix refuses to run without exact paid confirmation', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ax-continuation-matrix-test-'))
  let calls = 0
  const dependencies = {
    prepare: async () => {
      calls++
      throw new Error('must not prepare')
    },
    capture: async () => {
      calls++
      return 0
    },
    grade: async () => {
      calls++
      throw new Error('must not grade')
    },
  } as MatrixDependencies

  await expect(
    runMatrix({
      matrixRoot: join(parent, 'matrix'),
      model: 'local-model-id',
      confirmation: undefined,
      dependencies,
    })
  ).rejects.toThrow('exactly 9 paid runs require --confirm-paid-runs=9')
  expect(calls).toBe(0)
})

test('matrix captures and grades each committed slot exactly once', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ax-continuation-matrix-test-'))
  const matrixRoot = join(parent, 'matrix')
  const prepared: Condition[] = []
  const captured: Condition[] = []
  const graded: Condition[] = []
  const dependencies: MatrixDependencies = {
    prepare: async (runRoot, condition) => {
      prepared.push(condition)
      return { runRoot, condition } as unknown as PreparedRun
    },
    capture: async (run) => {
      captured.push((run as unknown as { condition: Condition }).condition)
      return 0
    },
    grade: async (_runRoot, condition) => {
      graded.push(condition)
      return gradable(condition, graded.length)
    },
  }

  const summary = await runMatrix({
    matrixRoot,
    model: 'local-model-id',
    confirmation: '9',
    dependencies,
  })

  expect(prepared).toEqual([...MATRIX_CONDITIONS])
  expect(captured).toEqual([...MATRIX_CONDITIONS])
  expect(graded).toEqual([...MATRIX_CONDITIONS])
  expect(summary.runs).toHaveLength(9)
  expect(summary.runs.map((run) => run.condition)).toEqual([...MATRIX_CONDITIONS])
  expect(summary.runs[0]!.answerFailureModes).toEqual({
    schemaInvalid: true,
    missingRecords: false,
    unexpectedRecords: false,
    duplicateRecords: false,
    orderingErrors: false,
    fieldMismatches: false,
  })
  expect(await Bun.file(join(matrixRoot, 'summary.json')).json()).toEqual(summary)
  const serialized = JSON.stringify(summary)
  expect(serialized).not.toContain('synthetic-')
  expect(serialized).not.toContain('local-model-id')
  expect(serialized).not.toContain('session_id')
  expect(serialized).not.toContain('/tmp/')
})

test('matrix stops without retry after a non-zero Claude exit', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ax-continuation-matrix-stop-'))
  const matrixRoot = join(parent, 'matrix')
  let preparedCount = 0
  let captureCount = 0
  let gradeCount = 0
  const dependencies: MatrixDependencies = {
    prepare: async (runRoot, condition) => {
      preparedCount++
      return { runRoot, condition } as unknown as PreparedRun
    },
    capture: async () => {
      captureCount++
      return captureCount === 2 ? 7 : 0
    },
    grade: async (_runRoot, condition) => {
      gradeCount++
      return gradable(condition, gradeCount)
    },
  }

  await expect(
    runMatrix({
      matrixRoot,
      model: 'local-model-id',
      confirmation: '9',
      dependencies,
    })
  ).rejects.toThrow('Claude capture exited non-zero')
  expect({ preparedCount, captureCount, gradeCount }).toEqual({
    preparedCount: 2,
    captureCount: 2,
    gradeCount: 1,
  })
  expect(await Bun.file(join(matrixRoot, 'matrix-status.json')).json()).toEqual({
    schemaVersion: 1,
    state: 'stopped',
    completedRuns: 1,
    stopReason: 'claude_nonzero',
  })
})

test('matrix records an infrastructure stop when preparation throws', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ax-continuation-matrix-infrastructure-'))
  const matrixRoot = join(parent, 'matrix')
  const dependencies: MatrixDependencies = {
    prepare: async () => {
      throw new Error('synthetic preparation failure')
    },
    capture: async () => 0,
    grade: async (_runRoot, condition) => gradable(condition, 1),
  }

  await expect(
    runMatrix({
      matrixRoot,
      model: 'local-model-id',
      confirmation: '9',
      dependencies,
    })
  ).rejects.toThrow('synthetic preparation failure')
  expect(await Bun.file(join(matrixRoot, 'matrix-status.json')).json()).toEqual({
    schemaVersion: 1,
    state: 'stopped',
    completedRuns: 0,
    stopReason: 'infrastructure_error',
  })
})

test.each(['capture', 'grade'] as const)(
  'matrix records an infrastructure stop when %s throws',
  async (stage) => {
    const parent = await mkdtemp(join(tmpdir(), 'ax-continuation-matrix-infrastructure-'))
    const matrixRoot = join(parent, 'matrix')
    const dependencies: MatrixDependencies = {
      prepare: async (runRoot, condition) => ({ runRoot, condition }) as unknown as PreparedRun,
      capture: async () => {
        if (stage === 'capture') throw new Error('synthetic capture failure')
        return 0
      },
      grade: async (_runRoot, condition) => {
        if (stage === 'grade') throw new Error('synthetic grade failure')
        return gradable(condition, 1)
      },
    }

    await expect(
      runMatrix({
        matrixRoot,
        model: 'local-model-id',
        confirmation: '9',
        dependencies,
      })
    ).rejects.toThrow(`synthetic ${stage} failure`)
    expect(await Bun.file(join(matrixRoot, 'matrix-status.json')).json()).toEqual({
      schemaVersion: 1,
      state: 'stopped',
      completedRuns: 0,
      stopReason: 'infrastructure_error',
    })
  }
)

test('matrix records an infrastructure stop when summary persistence throws', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ax-continuation-matrix-infrastructure-'))
  const matrixRoot = join(parent, 'matrix')
  const dependencies: MatrixDependencies = {
    prepare: async (runRoot, condition) => {
      await mkdir(join(matrixRoot, 'summary.json'))
      return { runRoot, condition } as unknown as PreparedRun
    },
    capture: async () => 0,
    grade: async (_runRoot, condition) => gradable(condition, 1),
  }

  await expect(
    runMatrix({
      matrixRoot,
      model: 'local-model-id',
      confirmation: '9',
      dependencies,
    })
  ).rejects.toThrow()
  expect(await Bun.file(join(matrixRoot, 'matrix-status.json')).json()).toEqual({
    schemaVersion: 1,
    state: 'stopped',
    completedRuns: 1,
    stopReason: 'infrastructure_error',
  })
})

test.each(['not_gradable', 'condition_violation'] as const)(
  'matrix stops after a %s grade',
  async (evidenceStatus) => {
    const parent = await mkdtemp(join(tmpdir(), 'ax-continuation-matrix-stop-'))
    const matrixRoot = join(parent, 'matrix')
    let captureCount = 0
    let gradeCount = 0
    const dependencies: MatrixDependencies = {
      prepare: async (runRoot, condition) => ({ runRoot, condition }) as unknown as PreparedRun,
      capture: async () => {
        captureCount++
        return 0
      },
      grade: async (_runRoot, condition) => {
        gradeCount++
        const grade = gradable(condition, gradeCount)
        return gradeCount === 3 ? { ...grade, evidenceStatus } : grade
      },
    }

    await expect(
      runMatrix({
        matrixRoot,
        model: 'local-model-id',
        confirmation: '9',
        dependencies,
      })
    ).rejects.toThrow(`matrix stopped: ${evidenceStatus}`)
    expect({ captureCount, gradeCount }).toEqual({ captureCount: 3, gradeCount: 3 })
    expect(await Bun.file(join(matrixRoot, 'matrix-status.json')).json()).toEqual({
      schemaVersion: 1,
      state: 'stopped',
      completedRuns: 2,
      stopReason: evidenceStatus,
    })
  }
)

test('matrix stops when a grade reports the wrong condition', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ax-continuation-matrix-condition-'))
  const matrixRoot = join(parent, 'matrix')
  let gradeCount = 0
  const dependencies: MatrixDependencies = {
    prepare: async (runRoot, condition) => ({ runRoot, condition }) as unknown as PreparedRun,
    capture: async () => 0,
    grade: async (_runRoot, condition) => {
      gradeCount++
      return gradable(gradeCount === 2 ? 'adoption-ablated' : condition, gradeCount)
    },
  }

  await expect(
    runMatrix({
      matrixRoot,
      model: 'local-model-id',
      confirmation: '9',
      dependencies,
    })
  ).rejects.toThrow('grade condition mismatch')
  expect(gradeCount).toBe(2)
  expect(await Bun.file(join(matrixRoot, 'matrix-status.json')).json()).toEqual({
    schemaVersion: 1,
    state: 'stopped',
    completedRuns: 1,
    stopReason: 'not_gradable',
  })
})

test('matrix CLI requires the local model before creating the root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ax-continuation-matrix-cli-'))
  const matrixRoot = join(parent, 'matrix')
  const env = { ...process.env }
  delete env.AX_BENCH_MODEL
  const proc = Bun.spawnSync(
    ['bun', new URL('./matrix.ts', import.meta.url).pathname, matrixRoot, '--confirm-paid-runs=9'],
    { cwd: process.cwd(), env }
  )
  expect(proc.exitCode).not.toBe(0)
  expect(proc.stderr.toString()).toContain('AX_BENCH_MODEL is required')
  expect(await Bun.file(matrixRoot).exists()).toBe(false)
})
