import { expect, test } from 'bun:test'
import type { MatrixSummary, PublicRunSummary } from './matrix'
import { MATRIX_CONDITIONS } from './matrix'
import { aggregateMatrix, renderResultsSection } from './report'
import type { Condition } from './run'

function publicRun(run: number, condition: Condition): PublicRunSummary {
  const adoption = condition === 'conformance' ? null : run % 2 === 0
  return {
    run,
    condition,
    publicModel: 'Sonnet 5',
    answerExact: run !== 2 && run !== 3,
    schemaValid: run !== 2,
    answerFailureModes: {
      schemaInvalid: run === 2,
      missingRecords: run === 3,
      unexpectedRecords: run === 3,
      duplicateRecords: false,
      orderingErrors: false,
      fieldMismatches: false,
    },
    protocolStatus: run === 3 ? 'fail' : 'pass',
    pageCount: 5,
    adoptedEnvelope: adoption,
    validChain: adoption,
    budgetCompliant: true,
    alternativeStrategy: adoption === false ? 'plain-ax' : null,
    turns: run,
    durationMs: run * 100,
    totalCostUsd: run / 100,
    inputTokens: run * 10,
    outputTokens: run * 5,
    cacheCreationInputTokens: run * 3,
    cacheReadInputTokens: run * 7,
  }
}

function matrix(): MatrixSummary {
  return {
    schemaVersion: 1,
    publicModel: 'Sonnet 5',
    runs: MATRIX_CONDITIONS.map((condition, index) => publicRun(index + 1, condition)),
  }
}

test('aggregates exactly three runs per condition with medians', () => {
  expect(aggregateMatrix(matrix())).toEqual([
    {
      condition: 'conformance',
      runs: 3,
      exactAnswers: 3,
      protocolPasses: 3,
      envelopeAdoptions: null,
      medianTurns: 4,
      medianDurationMs: 400,
      medianCostUsd: 0.04,
      medianInputTokens: 40,
      medianOutputTokens: 20,
    },
    {
      condition: 'adoption-guided',
      runs: 3,
      exactAnswers: 2,
      protocolPasses: 3,
      envelopeAdoptions: 2,
      medianTurns: 5,
      medianDurationMs: 500,
      medianCostUsd: 0.05,
      medianInputTokens: 50,
      medianOutputTokens: 25,
    },
    {
      condition: 'adoption-ablated',
      runs: 3,
      exactAnswers: 2,
      protocolPasses: 2,
      envelopeAdoptions: 1,
      medianTurns: 6,
      medianDurationMs: 600,
      medianCostUsd: 0.06,
      medianInputTokens: 60,
      medianOutputTokens: 30,
    },
  ])
})

test.each([
  {
    name: 'wrong model label',
    summary: { ...matrix(), publicModel: 'Other' },
    error: 'matrix public model must be Sonnet 5',
  },
  {
    name: 'wrong run count',
    summary: { ...matrix(), runs: matrix().runs.slice(0, 8) },
    error: 'matrix must contain exactly 9 runs',
  },
])('rejects $name', ({ summary, error }) => {
  expect(() => aggregateMatrix(summary as MatrixSummary)).toThrow(error)
})

test('renders a self-contained public results section without private fields', () => {
  const markdown = renderResultsSection(matrix())
  expect(markdown).toContain('## JSON-envelope continuation (Sonnet 5, n=3 per condition)')
  expect(markdown).toContain('### Method')
  expect(markdown).toContain('### Preliminary stopped attempts')
  expect(markdown).toContain(
    'Three earlier formal matrix invocations were stopped by gradability gates and excluded from the reported sample.'
  )
  expect(markdown).toContain('These are adaptive, exploratory results rather')
  expect(markdown).toContain('than a preregistered confirmatory evaluation.')
  expect(markdown).toContain('### Per-run results')
  expect(markdown).toContain('### Aggregate')
  expect(markdown).toContain('### Observed failure modes')
  expect(markdown).toContain(
    'Across 3 Adoption runs without envelope adoption, 3 used `plain-ax`; 1 failed protocol grading.'
  )
  expect(markdown).toContain(
    'Among 2 non-exact answers, 1 was schema-invalid. Among the 1 schema-valid non-exact answer, 1 had missing records, 1 had unexpected records, 0 had duplicate records, 0 had ordering errors, and 0 had field mismatches. Categories can overlap.'
  )
  expect(markdown).toContain('### Interpretation and limitations')
  expect(markdown).toContain('| 9 | Adoption ablated |')
  for (const forbidden of [
    'session_id',
    'trace',
    'cwd',
    'stderr',
    'rawTrace',
    'telemetryPath',
    'private-model-route',
    '/tmp/',
  ]) {
    expect(markdown).not.toContain(forbidden)
  }
})
