import type { MatrixSummary, PublicRunSummary } from './matrix'
import type { Condition } from './run'

export type ConditionAggregate = {
  condition: Condition
  runs: 3
  exactAnswers: number
  protocolPasses: number
  envelopeAdoptions: number | null
  medianTurns: number
  medianDurationMs: number
  medianCostUsd: number
  medianInputTokens: number
  medianOutputTokens: number
}

const CONDITION_ORDER: readonly Condition[] = ['conformance', 'adoption-guided', 'adoption-ablated']

const CONDITION_LABELS: Record<Condition, string> = {
  conformance: 'Conformance',
  'adoption-guided': 'Adoption guided',
  'adoption-ablated': 'Adoption ablated',
}

function median(values: number[]): number {
  return [...values].sort((left, right) => left - right)[1]!
}

function validateMatrix(summary: MatrixSummary): void {
  if (summary.publicModel !== 'Sonnet 5') {
    throw new Error('matrix public model must be Sonnet 5')
  }
  if (summary.runs.length !== 9) throw new Error('matrix must contain exactly 9 runs')
  const runNumbers = new Set(summary.runs.map((run) => run.run))
  if (runNumbers.size !== 9) throw new Error('matrix run numbers must be unique')
  for (const condition of CONDITION_ORDER) {
    if (summary.runs.filter((run) => run.condition === condition).length !== 3) {
      throw new Error(`matrix must contain exactly 3 ${condition} runs`)
    }
  }
}

export function aggregateMatrix(summary: MatrixSummary): ConditionAggregate[] {
  validateMatrix(summary)
  return CONDITION_ORDER.map((condition) => {
    const runs = summary.runs.filter((run) => run.condition === condition)
    return {
      condition,
      runs: 3,
      exactAnswers: runs.filter((run) => run.answerExact).length,
      protocolPasses: runs.filter((run) => run.protocolStatus === 'pass').length,
      envelopeAdoptions:
        condition === 'conformance'
          ? null
          : runs.filter((run) => run.adoptedEnvelope === true).length,
      medianTurns: median(runs.map((run) => run.turns)),
      medianDurationMs: median(runs.map((run) => run.durationMs)),
      medianCostUsd: median(runs.map((run) => run.totalCostUsd)),
      medianInputTokens: median(runs.map((run) => run.inputTokens)),
      medianOutputTokens: median(runs.map((run) => run.outputTokens)),
    }
  })
}

function yesNo(value: boolean | null): string {
  return value === null ? '—' : value ? 'yes' : 'no'
}

function perRunRow(run: PublicRunSummary): string {
  return [
    run.run,
    CONDITION_LABELS[run.condition],
    yesNo(run.answerExact),
    run.protocolStatus,
    yesNo(run.adoptedEnvelope),
    run.pageCount,
    run.turns,
    (run.durationMs / 1000).toFixed(1),
    run.inputTokens,
    run.outputTokens,
    run.cacheCreationInputTokens,
    run.cacheReadInputTokens,
    `$${run.totalCostUsd.toFixed(3)}`,
  ].join(' | ')
}

function observedFailureMode(summary: MatrixSummary): string {
  const nonAdopters = summary.runs.filter(
    (run) => run.condition !== 'conformance' && run.adoptedEnvelope === false
  )
  if (nonAdopters.length === 0) return 'All Adoption runs adopted envelopes.'

  const strategyCounts = new Map<string, number>()
  for (const run of nonAdopters) {
    const strategy = run.alternativeStrategy ?? 'no-recorded-alternative'
    strategyCounts.set(strategy, (strategyCounts.get(strategy) ?? 0) + 1)
  }
  const strategies = [...strategyCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([strategy, count]) => `${count} used \`${strategy}\``)
    .join(', ')
  const protocolFailures = nonAdopters.filter((run) => run.protocolStatus === 'fail').length

  return (
    `Across ${nonAdopters.length} Adoption runs without envelope adoption, ${strategies}; ` +
    `${protocolFailures} failed protocol grading.`
  )
}

function observedAnswerFailureModes(summary: MatrixSummary): string {
  const nonExact = summary.runs.filter((run) => !run.answerExact)
  const schemaValidNonExact = nonExact.filter((run) => run.schemaValid)
  const count = (mode: keyof PublicRunSummary['answerFailureModes']) =>
    schemaValidNonExact.filter((run) => run.answerFailureModes[mode]).length
  const schemaInvalid = nonExact.filter((run) => run.answerFailureModes.schemaInvalid).length
  const comparableAnswers = schemaValidNonExact.length

  return (
    `Among ${nonExact.length} non-exact answers, ${schemaInvalid} ` +
    `${schemaInvalid === 1 ? 'was' : 'were'} schema-invalid. ` +
    `Among the ${comparableAnswers} schema-valid non-exact ` +
    `${comparableAnswers === 1 ? 'answer' : 'answers'}, ` +
    `${count('missingRecords')} had missing records, ` +
    `${count('unexpectedRecords')} had unexpected records, ` +
    `${count('duplicateRecords')} had duplicate records, ` +
    `${count('orderingErrors')} had ordering errors, and ` +
    `${count('fieldMismatches')} had field mismatches. Categories can overlap.`
  )
}

export function renderResultsSection(summary: MatrixSummary): string {
  const aggregates = aggregateMatrix(summary)
  const perRunRows = [...summary.runs]
    .sort((left, right) => left.run - right.run)
    .map((run) => `| ${perRunRow(run)} |`)
  const aggregateRows = aggregates.map(
    (aggregate) =>
      `| ${CONDITION_LABELS[aggregate.condition]} | ${aggregate.exactAnswers}/3 | ` +
      `${aggregate.protocolPasses}/3 | ` +
      `${aggregate.envelopeAdoptions === null ? '—' : `${aggregate.envelopeAdoptions}/3`} | ` +
      `${aggregate.medianTurns} | ${(aggregate.medianDurationMs / 1000).toFixed(1)} | ` +
      `${aggregate.medianInputTokens} | ${aggregate.medianOutputTokens} | ` +
      `$${aggregate.medianCostUsd.toFixed(3)} |`
  )

  return [
    '## JSON-envelope continuation (Sonnet 5, n=3 per condition)',
    '',
    '### Method',
    '',
    'A deterministic 120-row HTML fixture was generated from an independent fixed seed.',
    'Each run used budget 600, while ground truth remained in the parent process.',
    'Conformance explicitly taught continuation; Adoption compared the same natural task',
    'with the full Skill versus a runtime-only continuation-guidance ablation.',
    'Raw session records stayed outside the repository.',
    '',
    '### Preliminary stopped attempts',
    '',
    'Three earlier formal matrix invocations were stopped by gradability gates and excluded from the reported sample.',
    'They exposed fixture-metadata preflights, compound or interpreter-wrapped ax commands,',
    'and terminal responses containing text outside the required JSON object.',
    'The methodology was then changed to require standalone ax calls, prohibit all non-ax',
    'fixture access, enforce a JSON-only response, and tighten access auditing before the',
    'final matrix was collected. A post-run review further replaced permissive non-ax',
    'handling with a conservative allowlist; regrading the retained runs did not change',
    'their gradability or published scores. These are adaptive, exploratory results rather',
    'than a preregistered confirmatory evaluation.',
    '',
    '### Per-run results',
    '',
    '| Run | Condition | Exact | Protocol | Envelope | Pages | Turns | Duration (s) | Input | Output | Cache create | Cache read | Cost |',
    '| ---: | --- | :---: | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...perRunRows,
    '',
    '### Aggregate',
    '',
    '| Condition | Exact | Protocol pass | Envelope adoption | Median turns | Median duration (s) | Median input | Median output | Median cost |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...aggregateRows,
    '',
    '### Observed failure modes',
    '',
    observedFailureMode(summary),
    observedAnswerFailureModes(summary),
    '',
    '### Interpretation and limitations',
    '',
    'Answer correctness, continuation-protocol correctness, and active envelope adoption',
    'are reported separately. Each condition has only three runs on one deterministic',
    'fixture and one model, so differences are descriptive rather than general claims.',
    'Claude Code event structure may also change across CLI versions.',
    '',
  ].join('\n')
}

if (import.meta.main) {
  const summaryPath = process.argv[2]
  if (!summaryPath) throw new Error('matrix summary path is required')
  const summary = (await Bun.file(summaryPath).json()) as MatrixSummary
  process.stdout.write(renderResultsSection(summary))
}
