import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONTINUATION_BUDGET,
  CONTINUATION_ROW_SPEC,
  CONTINUATION_SEED,
  CONTINUATION_SELECTOR,
  generateFixture,
  writeAgentFixture,
} from './fixture'
import { gradeRunRoot } from './grade-run'
import { gradeAdoption, gradeAnswer, gradeProtocol } from './grade'
import { inspectStreamShapes } from './inspect-stream'
import { ablateContinuationGuidance, applySkill, renderContinuationPrompt } from './prompt'
import { buildClaudeArgs, capturePilot, preflightAx, prepareRun, provisionAx } from './run'
import { hasOverlappingInvocations, readAxTelemetry, type AxInvocation } from './telemetry'

function call(argv: string[], stdout: unknown, start: number): AxInvocation {
  return {
    argv,
    cwd: '/agent',
    stdout: JSON.stringify(stdout),
    stderr: '',
    exitCode: 0,
    startedAtMs: start,
    endedAtMs: start + 1,
  }
}

function syntheticRunStream(
  invocations: AxInvocation[],
  options: { directRead?: boolean; finalText?: string } = {}
): string {
  const events: string[] = []
  if (options.directRead) {
    events.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'direct-read',
              name: 'Read',
              input: { file_path: 'continuation.html' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'direct-read',
              content: 'synthetic direct result',
              is_error: false,
            },
          ],
        },
      })
    )
  }
  events.push(
    ...invocations.flatMap((invocation, index) => [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: `synthetic-tool-${index + 1}`,
              name: 'Bash',
              input: { command: ['ax', ...invocation.argv].join(' ') },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: `synthetic-tool-${index + 1}`,
              content: invocation.stdout,
              is_error: false,
            },
          ],
        },
      }),
    ]),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: options.finalText ?? JSON.stringify({ records: generateFixture().records }),
      duration_ms: 1200,
      num_turns: 7,
      total_cost_usd: 0.125,
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 13,
      },
    })
  )
  return `${events.join('\n')}\n`
}

function skillBodyForTest(markdown: string): string {
  const closing = markdown.indexOf('\n---', 4)
  if (!markdown.startsWith('---\n') || closing === -1) {
    throw new Error('test Skill must contain YAML frontmatter')
  }
  return markdown.slice(closing + 4).replace(/^\n+/, '')
}

describe('continuation fixture', () => {
  test('is deterministic, shuffled, and contains 120 unique incidents', () => {
    const first = generateFixture()
    const second = generateFixture()
    expect(first).toEqual(second)
    expect(first.records).toHaveLength(120)
    expect(new Set(first.records.map((record) => record.id)).size).toBe(120)
    expect(first.records.slice(0, 3).map((record) => record.id)).not.toEqual([
      'INC-73001',
      'INC-73002',
      'INC-73003',
    ])
    expect(first.html.match(/class="incident"/g)).toHaveLength(120)
    expect(first.html).toContain('class="incident-preview"')
  })

  test('writes only HTML into the Agent directory and returns truth in memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ax-continuation-agent-'))
    const expected = generateFixture().records
    const records = await writeAgentFixture(dir)
    expect(records).toEqual(expected)
    expect(await readdir(dir)).toEqual(['continuation.html'])
  })

  test('locks the public extraction contract', () => {
    expect(CONTINUATION_BUDGET).toBe(600)
    expect(CONTINUATION_SELECTOR).toBe('.incident')
    expect(CONTINUATION_ROW_SPEC).toBe('id=@data-id,owner=.owner,severity=.severity,status=.status')
  })
})

describe('continuation prompts', () => {
  test('replaces exactly one budget token', () => {
    expect(renderContinuationPrompt('use {{BUDGET}} exactly', 600)).toBe('use 600 exactly')
    expect(() => renderContinuationPrompt('no token', 600)).toThrow('exactly one {{BUDGET}}')
    expect(() => renderContinuationPrompt('{{BUDGET}} {{BUDGET}}', 600)).toThrow(
      'exactly one {{BUDGET}}'
    )
  })

  test('condition prompts share neutral evidence constraints', async () => {
    const [conformance, adoption] = await Promise.all([
      Bun.file('bench/prompts/continuation-conformance.txt').text(),
      Bun.file('bench/prompts/continuation-adoption.txt').text(),
    ])
    const standaloneRule =
      'Run each ax invocation as one standalone Bash command. Do not combine it with another command or use pipes, redirections, multiline commands, heredocs, scripts, interpreters, shell functions, command substitutions, wrappers, or subprocesses.'
    const fixtureIsolationRule =
      'Do not use any other tool or command to access, inspect, locate, list, search, copy, transform, or read continuation.html. You may locate ax only with a command that does not mention continuation.html.'
    const responseBoundaryRule =
      'Before responding, silently verify that the response starts with {, ends with }, and contains exactly one JSON object with no prefix, suffix, completion note, Markdown fence, or commentary.'

    for (const prompt of [conformance, adoption]) {
      expect(prompt).toContain(standaloneRule)
      expect(prompt).toContain(fixtureIsolationRule)
      expect(prompt).toContain(responseBoundaryRule)
    }
    expect(adoption).not.toMatch(
      /--json-envelope|--offset|meta\.|pagination|continuation(?!\.html)|terminal states?|multiple pages?/i
    )
  })

  test('ablates only the complete continuation bullet', () => {
    const target = [
      '- For automated continuation, use `--json-envelope`. Read `data`; when',
      '  `meta.state` is `more`, rerun the same command with',
      '  `--offset <meta.next_offset>`. Continue only while it is `more`; stop on',
      '  `complete` or `past_end`; do not restart from zero or increase the budget.',
    ].join('\n')
    const skill = [
      '---',
      'name: ax',
      '---',
      '# ax',
      '',
      '## Output rules',
      '',
      '- Default cap.',
      target,
      '## Next section',
      'Keep this body byte-for-byte.',
    ].join('\n')
    const ablated = ablateContinuationGuidance(skill)
    expect(ablated).toBe(
      [
        '---',
        'name: ax',
        '---',
        '# ax',
        '',
        '## Output rules',
        '',
        '- Default cap.',
        '## Next section',
        'Keep this body byte-for-byte.',
      ].join('\n')
    )
    expect(() => ablateContinuationGuidance(ablated)).toThrow('exactly one continuation bullet')
  })

  test('guided and ablated preserve all non-continuation Skill text', async () => {
    const markdown = await Bun.file('skills/ax/SKILL.md').text()
    const prompt = 'task'
    const target = `${[
      '- For automated continuation, use `--json-envelope`. Read `data`; when',
      '  `meta.state` is `more`, rerun the same command with',
      '  `--offset <meta.next_offset>`. Continue only while it is `more`; stop on',
      '  `complete` or `past_end`; do not restart from zero or increase the budget.',
    ].join('\n')}\n`
    const start = markdown.indexOf(target)
    expect(start).toBeGreaterThanOrEqual(0)
    const expectedAblated = markdown.slice(0, start) + markdown.slice(start + target.length)
    expect(applySkill(prompt, markdown, 'guided')).toContain('--json-envelope')
    expect(ablateContinuationGuidance(markdown)).toBe(expectedAblated)
    expect(applySkill(prompt, markdown, 'ablated')).toBe(
      `${skillBodyForTest(expectedAblated)}\n\n${prompt}`
    )
    expect(applySkill(prompt, markdown, 'none')).toBe(prompt)
  })
})

describe('instrumented ax', () => {
  test('resolves the shim, preserves output, and records each semicolon command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ax-continuation-run-'))
    const agentDir = join(root, 'agent')
    await mkdir(agentDir)
    await writeAgentFixture(agentDir)
    const provisioned = await provisionAx(process.cwd(), root)
    await preflightAx(provisioned, join(agentDir, 'continuation.html'))

    const shell = Bun.spawnSync(
      [
        'sh',
        '-c',
        "ax continuation.html '.incident' --count; ax continuation.html '.incident' --count",
      ],
      { cwd: agentDir, env: provisioned.childEnv }
    )
    expect(shell.exitCode).toBe(0)
    expect(shell.stdout.toString()).toBe('120\n120\n')
    const calls = await readAxTelemetry(provisioned.telemetryPath)
    expect(calls.map((call) => call.argv.at(-1))).toEqual(['--count', '--count'])
    expect(hasOverlappingInvocations(calls)).toBe(false)
  })

  test('replays both streams and a non-zero exit from ax-real into telemetry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ax-continuation-shim-'))
    const agentDir = join(root, 'agent')
    await mkdir(agentDir)
    const provisioned = await provisionAx(process.cwd(), root)
    const fakeReal = join(root, 'fake-ax-real')
    await Bun.write(
      fakeReal,
      [
        '#!/bin/sh',
        `printf '%s\\n' 'fake stdout'`,
        `printf '%s\\n' 'fake stderr' >&2`,
        'exit 7',
      ].join('\n')
    )
    await chmod(fakeReal, 0o755)
    const proc = Bun.spawnSync([provisioned.axPath, 'continuation.html'], {
      cwd: agentDir,
      env: { ...provisioned.childEnv, AX_BENCH_REAL: fakeReal },
    })
    expect(proc.exitCode).toBe(7)
    expect(proc.stdout.toString()).toBe('fake stdout\n')
    expect(proc.stderr.toString()).toBe('fake stderr\n')
    const calls = await readAxTelemetry(provisioned.telemetryPath)
    const canonicalAgentDir = await realpath(agentDir)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      argv: ['continuation.html'],
      cwd: canonicalAgentDir,
      stdout: 'fake stdout\n',
      stderr: 'fake stderr\n',
      exitCode: 7,
    })
  })

  test('reconstructs 120 records in five fixed-budget pages through the shim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ax-continuation-pages-'))
    const agentDir = join(root, 'agent')
    await mkdir(agentDir)
    const expected = await writeAgentFixture(agentDir)
    const provisioned = await provisionAx(process.cwd(), root)
    await preflightAx(provisioned, join(agentDir, 'continuation.html'))
    const actual: unknown[] = []
    let offset = 0
    let pages = 0
    while (true) {
      const args = [
        'continuation.html',
        CONTINUATION_SELECTOR,
        '--row',
        CONTINUATION_ROW_SPEC,
        '--json-envelope',
        '--budget',
        String(CONTINUATION_BUDGET),
      ]
      if (offset > 0) args.push('--offset', String(offset))
      const proc = Bun.spawnSync(['ax', ...args], {
        cwd: agentDir,
        env: provisioned.childEnv,
      })
      expect(proc.exitCode).toBe(0)
      const envelope = JSON.parse(proc.stdout.toString())
      actual.push(...envelope.data)
      pages++
      if (envelope.meta.state !== 'more') {
        expect(envelope.meta.state).toBe('complete')
        break
      }
      offset = envelope.meta.next_offset
    }
    expect(actual).toEqual(expected)
    expect(new Set(actual.map((record) => (record as { id: string }).id)).size).toBe(120)
    expect(pages).toBe(5)
    expect(await readAxTelemetry(provisioned.telemetryPath)).toHaveLength(5)
    expect(await readdir(agentDir)).toEqual(['continuation.html'])
    // Spawns bun+ax six times; on a loaded machine that can exceed the
    // default 5s test timeout (seen in CI-adjacent runs), so give it room.
  }, 30_000)
})

describe('continuation grading', () => {
  const base = [
    'continuation.html',
    '.incident',
    '--row',
    CONTINUATION_ROW_SPEC,
    '--json-envelope',
    '--budget',
    '600',
  ]

  test('answer grade separates missing, duplicate, order, and field failures', () => {
    const expected = generateFixture().records.slice(0, 3)
    expect(gradeAnswer(JSON.stringify({ records: expected }), expected).exact).toBe(true)

    const duplicate = [expected[0]!, expected[0]!, expected[2]!]
    const duplicateGrade = gradeAnswer(JSON.stringify({ records: duplicate }), expected)
    expect(duplicateGrade.exact).toBe(false)
    expect(duplicateGrade.duplicateIds).toEqual([expected[0]!.id])
    expect(duplicateGrade.missingIds).toEqual([expected[1]!.id])

    const fieldMismatch = [expected[0]!, { ...expected[1]!, owner: 'wrong-owner' }, expected[2]!]
    expect(
      gradeAnswer(JSON.stringify({ records: fieldMismatch }), expected).fieldMismatchIds
    ).toEqual([expected[1]!.id])

    const unexpected = [expected[0]!, expected[1]!, { ...expected[2]!, id: 'INC-99999' }]
    expect(gradeAnswer(JSON.stringify({ records: unexpected }), expected).unexpectedIds).toEqual([
      'INC-99999',
    ])
  })

  test('answer grade does not report a missing record as reordering', () => {
    const expected = generateFixture().records.slice(0, 3)
    const grade = gradeAnswer(JSON.stringify({ records: [expected[0]!, expected[2]!] }), expected)
    expect(grade.missingIds).toEqual([expected[1]!.id])
    expect(grade.outOfOrderIds).toEqual([])

    const reordered = gradeAnswer(
      JSON.stringify({ records: [expected[2]!, expected[0]!] }),
      expected
    )
    expect(reordered.outOfOrderIds).toEqual([expected[2]!.id, expected[0]!.id])
  })

  test.each([
    ['severity', ['S1']],
    ['severity', { toString: null }],
    ['severity', null],
    ['status', ['open']],
    ['status', { toString: null }],
    ['status', null],
  ] as const)('answer grade rejects non-string %s values', (field, value) => {
    const expected = generateFixture().records.slice(0, 1)
    const malformed = { ...expected[0]!, [field]: value }
    const grade = gradeAnswer(JSON.stringify({ records: [malformed] }), expected)
    expect(grade.schemaValid).toBe(false)
    expect(grade.exact).toBe(false)
  })

  test.each([
    ['unparseable JSON', '{not-json'],
    [
      'invalid record schema',
      JSON.stringify({
        records: [{ id: 'INC-00001', owner: 'owner', severity: ['S1'], status: 'open' }],
      }),
    ],
  ])('answer grade leaves record-level failures unknown for %s', (_name, finalText) => {
    const expected = generateFixture().records.slice(0, 1)
    expect(gradeAnswer(finalText, expected)).toEqual({
      exact: false,
      schemaValid: false,
      missingIds: [],
      unexpectedIds: [],
      duplicateIds: [],
      outOfOrderIds: [],
      fieldMismatchIds: [],
    })
  })

  test('protocol grade accepts only an exact offset chain', () => {
    const invocations = [
      call(
        base,
        {
          data: [{ id: 'a' }],
          meta: { state: 'more', offset: 0, returned: 1, next_offset: 1 },
        },
        1
      ),
      call(
        [...base, '--offset', '1'],
        {
          data: [{ id: 'b' }],
          meta: { state: 'complete', offset: 1, returned: 1, next_offset: null },
        },
        3
      ),
    ]
    const protocol = gradeProtocol(invocations, 600)
    expect(protocol.status).toBe('pass')
    expect(gradeAdoption(invocations, protocol, 600, true)).toEqual({
      adoptedEnvelope: true,
      validChain: true,
      budgetCompliant: true,
      alternativeStrategy: null,
      finalAnswerExact: true,
    })
  })

  test.each([
    ['restart', '0'],
    ['gap', '2'],
  ])('protocol grade rejects %s offsets', (_name, offset) => {
    const fixture = generateFixture()
    const invocations = [
      call(
        base,
        {
          data: fixture.records.slice(0, 1),
          meta: { state: 'more', offset: 0, returned: 1, next_offset: 1 },
        },
        1
      ),
      call(
        [...base, '--offset', offset],
        {
          data: [],
          meta: {
            state: 'complete',
            offset: Number(offset),
            returned: 0,
            next_offset: null,
          },
        },
        3
      ),
    ]
    expect(gradeProtocol(invocations, 600).status).toBe('fail')
  })

  test('protocol grade audits bypass calls before the legal envelope chain', () => {
    const bypass = call(['continuation.html', '.incident', '--all'], [], 1)
    const chain = [
      call(
        base,
        {
          data: [{ id: 'a' }],
          meta: { state: 'more', offset: 0, returned: 1, next_offset: 1 },
        },
        3
      ),
      call(
        [...base, '--offset', '1'],
        {
          data: [{ id: 'b' }],
          meta: { state: 'complete', offset: 1, returned: 1, next_offset: null },
        },
        5
      ),
    ]
    const grade = gradeProtocol([bypass, ...chain], 600)
    expect(grade.status).toBe('fail')
    expect(grade.issues).toContain('--all bypass')
  })

  test('protocol grade rejects explicit limits and zero-progress more pages', () => {
    const argv = [...base, '--limit', '50']
    const grade = gradeProtocol(
      [
        call(
          argv,
          {
            data: [],
            meta: { state: 'more', offset: 0, returned: 0, next_offset: 0 },
          },
          1
        ),
      ],
      600
    )
    expect(grade.status).toBe('fail')
    expect(grade.issues).toContain('--limit is forbidden')
    expect(grade.issues).toContain('zero-progress page')
  })

  test.each(['complete', 'past_end'] as const)(
    'protocol grade rejects discovery after %s',
    (state) => {
      const terminalData = state === 'complete' ? [{ id: 'b' }] : []
      const terminalReturned = terminalData.length
      const invocations = [
        call(
          base,
          {
            data: [{ id: 'a' }],
            meta: { state: 'more', offset: 0, returned: 1, next_offset: 1 },
          },
          1
        ),
        call(
          [...base, '--offset', '1'],
          {
            data: terminalData,
            meta: { state, offset: 1, returned: terminalReturned, next_offset: null },
          },
          3
        ),
        call(['continuation.html', '.incident', '--count'], 120, 5),
      ]
      const grade = gradeProtocol(invocations, 600)
      expect(grade.status).toBe('fail')
      expect(grade.issues).toContain('fixture call after terminal state')
    }
  )

  test.each([
    ['missing budget', base.filter((arg) => arg !== '--budget' && arg !== '600')],
    ['changed budget', base.map((arg) => (arg === '600' ? '900' : arg))],
  ])('protocol grade rejects %s', (_name, argv) => {
    const grade = gradeProtocol(
      [
        call(
          argv,
          {
            data: [{ id: 'a' }],
            meta: { state: 'complete', offset: 0, returned: 1, next_offset: null },
          },
          1
        ),
      ],
      600
    )
    expect(grade.status).toBe('fail')
  })

  test('protocol grade rejects command drift after the first page', () => {
    const drifted = [...base]
    drifted[1] = '.other'
    const invocations = [
      call(
        base,
        {
          data: [{ id: 'a' }],
          meta: { state: 'more', offset: 0, returned: 1, next_offset: 1 },
        },
        1
      ),
      call(
        [...drifted, '--offset', '1'],
        {
          data: [{ id: 'b' }],
          meta: { state: 'complete', offset: 1, returned: 1, next_offset: null },
        },
        3
      ),
    ]
    const grade = gradeProtocol(invocations, 600)
    expect(grade.status).toBe('fail')
    expect(grade.issues).toContain('command drift')
  })

  test('protocol grade reports malformed, missing, and overlapping evidence', () => {
    const malformed = call(base, {}, 1)
    malformed.stdout = '{'
    expect(gradeProtocol([malformed], 600).status).toBe('not_gradable')
    expect(gradeProtocol([], 600).status).toBe('not_gradable')

    const first = call(
      base,
      {
        data: [{ id: 'a' }],
        meta: { state: 'more', offset: 0, returned: 1, next_offset: 1 },
      },
      1
    )
    const second = call(
      [...base, '--offset', '1'],
      {
        data: [{ id: 'b' }],
        meta: { state: 'complete', offset: 1, returned: 1, next_offset: null },
      },
      1.5
    )
    expect(gradeProtocol([first, second], 600).status).toBe('not_gradable')
  })

  test('adoption grade records alternative strategy and final correctness', () => {
    const invocations = [
      call(
        [
          'continuation.html',
          '.incident',
          '--row',
          CONTINUATION_ROW_SPEC,
          '--budget',
          '600',
          '--offset',
          '1',
        ],
        [],
        1
      ),
    ]
    const protocol = gradeProtocol(invocations, 600)
    expect(gradeAdoption(invocations, protocol, 600, true)).toEqual({
      adoptedEnvelope: false,
      validChain: false,
      budgetCompliant: true,
      alternativeStrategy: 'offset-without-envelope',
      finalAnswerExact: true,
    })
  })

  test('adoption grade preserves a fallback after an envelope attempt', () => {
    const attempt = call(
      base,
      {
        data: [{ id: 'a' }],
        meta: { state: 'more', offset: 0, returned: 1, next_offset: 1 },
      },
      1
    )
    const fallback = call(
      ['continuation.html', '.incident', '--all', '--budget', '600'],
      [{ id: 'a' }],
      3
    )
    const invocations = [attempt, fallback]
    const protocol = gradeProtocol(invocations, 600)
    const adoption = gradeAdoption(invocations, protocol, 600, true)
    expect(adoption.adoptedEnvelope).toBe(true)
    expect(adoption.validChain).toBe(false)
    expect(adoption.alternativeStrategy).toBe('all')
  })

  test('grade-run combines answer, protocol, access, and metrics', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'ax-continuation-grade-'))
    const telemetryDir = join(runRoot, 'telemetry')
    await mkdir(telemetryDir)
    const invocations = [
      call(
        base,
        {
          data: [{ id: 'a' }],
          meta: { state: 'more', offset: 0, returned: 1, next_offset: 1 },
        },
        1
      ),
      call(
        [...base, '--offset', '1'],
        {
          data: [{ id: 'b' }],
          meta: { state: 'more', offset: 1, returned: 1, next_offset: 2 },
        },
        3
      ),
      call(
        [...base, '--offset', '2'],
        {
          data: [{ id: 'c' }],
          meta: { state: 'complete', offset: 2, returned: 1, next_offset: null },
        },
        5
      ),
    ]
    await Bun.write(
      join(telemetryDir, 'ax.jsonl'),
      `${invocations.map((item) => JSON.stringify(item)).join('\n')}\n`
    )
    const stream = [
      ...invocations.flatMap((invocation, index) => [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: `tool-${index + 1}`,
                name: 'Bash',
                input: { command: ['ax', ...invocation.argv].join(' ') },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: `tool-${index + 1}`,
                content: invocation.stdout,
                is_error: false,
              },
            ],
          },
        }),
      ]),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify({ records: generateFixture().records }),
        duration_ms: 1200,
        num_turns: 7,
        total_cost_usd: 0.125,
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 13,
        },
      }),
    ].join('\n')
    await Bun.write(join(runRoot, 'stream.jsonl'), `${stream}\n`)

    expect(await gradeRunRoot(runRoot, 'conformance')).toEqual({
      evidenceStatus: 'gradable',
      condition: 'conformance',
      answer: {
        exact: true,
        schemaValid: true,
        missingIds: [],
        unexpectedIds: [],
        duplicateIds: [],
        outOfOrderIds: [],
        fieldMismatchIds: [],
      },
      protocol: {
        status: 'pass',
        issues: [],
        pageCount: 3,
      },
      adoption: null,
      access: {
        status: 'pass',
        issues: [],
        alternativeStrategy: null,
      },
      metrics: {
        durationMs: 1200,
        turns: 7,
        totalCostUsd: 0.125,
        inputTokens: 11,
        outputTokens: 7,
        cacheCreationInputTokens: 5,
        cacheReadInputTokens: 13,
      },
      issues: [],
    })
  })

  test('grade-run rejects a chain outside the calibrated page range', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'ax-continuation-grade-short-'))
    const telemetryDir = join(runRoot, 'telemetry')
    await mkdir(telemetryDir)
    const invocations = [
      call(
        base,
        {
          data: [{ id: 'a' }],
          meta: { state: 'more', offset: 0, returned: 1, next_offset: 1 },
        },
        1
      ),
      call(
        [...base, '--offset', '1'],
        {
          data: [{ id: 'b' }],
          meta: { state: 'complete', offset: 1, returned: 1, next_offset: null },
        },
        3
      ),
    ]
    await Bun.write(
      join(telemetryDir, 'ax.jsonl'),
      `${invocations.map((item) => JSON.stringify(item)).join('\n')}\n`
    )
    const stream = [
      ...invocations.flatMap((invocation, index) => [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: `short-tool-${index + 1}`,
                name: 'Bash',
                input: { command: ['ax', ...invocation.argv].join(' ') },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: `short-tool-${index + 1}`,
                content: invocation.stdout,
                is_error: false,
              },
            ],
          },
        }),
      ]),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify({ records: generateFixture().records }),
        duration_ms: 1,
        num_turns: 2,
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    ].join('\n')
    await Bun.write(join(runRoot, 'stream.jsonl'), `${stream}\n`)
    const grade = await gradeRunRoot(runRoot, 'conformance')
    expect(grade.evidenceStatus).toBe('gradable')
    expect(grade.protocol.status).toBe('fail')
    expect(grade.protocol.pageCount).toBe(2)
    expect(grade.protocol.issues).toContain('page count outside calibrated range')
  })

  test('grade-run records direct fixture access as an adoption condition violation', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'ax-continuation-grade-direct-'))
    const telemetryDir = join(runRoot, 'telemetry')
    await mkdir(telemetryDir)
    const invocations = [
      call(
        base,
        {
          data: [{ id: 'a' }],
          meta: { state: 'more', offset: 0, returned: 1, next_offset: 1 },
        },
        1
      ),
      call(
        [...base, '--offset', '1'],
        {
          data: [{ id: 'b' }],
          meta: { state: 'more', offset: 1, returned: 1, next_offset: 2 },
        },
        3
      ),
      call(
        [...base, '--offset', '2'],
        {
          data: [{ id: 'c' }],
          meta: { state: 'complete', offset: 2, returned: 1, next_offset: null },
        },
        5
      ),
    ]
    await Bun.write(
      join(telemetryDir, 'ax.jsonl'),
      `${invocations.map((item) => JSON.stringify(item)).join('\n')}\n`
    )
    await Bun.write(
      join(runRoot, 'stream.jsonl'),
      syntheticRunStream(invocations, { directRead: true })
    )

    const grade = await gradeRunRoot(runRoot, 'adoption-guided')
    expect(grade.evidenceStatus).toBe('condition_violation')
    expect(grade.access.status).toBe('violation')
    expect(grade.adoption?.alternativeStrategy).toBe('direct-fixture-read')
    expect(grade.answer?.exact).toBe(true)
  })

  test('direct fixture access remains a violation without ax telemetry', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'ax-continuation-grade-direct-only-'))
    await mkdir(join(runRoot, 'telemetry'))
    await Bun.write(join(runRoot, 'telemetry', 'ax.jsonl'), '')
    await Bun.write(join(runRoot, 'stream.jsonl'), syntheticRunStream([], { directRead: true }))

    const grade = await gradeRunRoot(runRoot, 'adoption-ablated')
    expect(grade.protocol.status).toBe('not_gradable')
    expect(grade.access.status).toBe('violation')
    expect(grade.evidenceStatus).toBe('condition_violation')
    expect(grade.adoption?.alternativeStrategy).toBe('direct-fixture-read')
  })

  test('grade-run returns not_gradable for a malformed stream', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'ax-continuation-grade-malformed-'))
    await mkdir(join(runRoot, 'telemetry'))
    await Bun.write(join(runRoot, 'telemetry', 'ax.jsonl'), '')
    await Bun.write(join(runRoot, 'stream.jsonl'), '{\n')

    const grade = await gradeRunRoot(runRoot, 'conformance')
    expect(grade.evidenceStatus).toBe('not_gradable')
    expect(grade.answer).toBeNull()
    expect(grade.metrics).toBeNull()
    expect(grade.issues).toContain('invalid stream JSON')
  })
})

describe('continuation runner', () => {
  test('Claude args capture stream-json without session reuse', () => {
    const args = buildClaudeArgs('local-model-id', 'prompt')
    expect(args).toEqual([
      'claude',
      '-p',
      'prompt',
      '--model',
      'local-model-id',
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      'Bash,Read,Grep,Glob',
      '--max-turns',
      '40',
    ])
    expect(args).not.toContain('--resume')
  })

  test('prepareRun exposes only HTML to the Agent and uses the exact condition prompt', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ax-continuation-run-'))
    const prepared = await prepareRun(join(parent, 'run'), 'adoption-ablated')
    expect(await readdir(prepared.agentDir)).toEqual(['continuation.html'])
    expect(prepared.prompt).toContain('Use ax')
    expect(prepared.prompt).toContain('--budget 600')
    expect(prepared.prompt).not.toContain('For automated continuation')
    expect(prepared.truth).toEqual(generateFixture().records)
    expect(JSON.parse(await Bun.file(join(prepared.runRoot, 'manifest.json')).text())).toEqual({
      schemaVersion: 1,
      condition: 'adoption-ablated',
      publicModel: 'Sonnet 5',
      seed: CONTINUATION_SEED,
      budget: CONTINUATION_BUDGET,
    })
  })

  test('prepareRun rejects repository descendants before creating them', async () => {
    await expect(prepareRun(process.cwd(), 'conformance')).rejects.toThrow(
      'run-root must be outside the repository'
    )

    const forbidden = join(process.cwd(), 'bench', '.continuation-run-must-not-exist')
    await expect(prepareRun(forbidden, 'conformance')).rejects.toThrow(
      'run-root must be outside the repository'
    )
    expect(await Bun.file(forbidden).exists()).toBe(false)

    const parent = await mkdtemp(join(tmpdir(), 'ax-continuation-symlink-'))
    const repoLink = join(parent, 'repo-link')
    await symlink(process.cwd(), repoLink, 'dir')
    const linkedForbidden = join(repoLink, 'bench', '.continuation-run-must-not-exist')
    await expect(prepareRun(linkedForbidden, 'conformance')).rejects.toThrow(
      'run-root must be outside the repository'
    )
    expect(await Bun.file(linkedForbidden).exists()).toBe(false)
  })

  test('capture preserves raw streams and the inspector emits structure only', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ax-continuation-fake-'))
    const runRoot = join(parent, 'run')
    const prepared = await prepareRun(runRoot, 'conformance')
    const fakeBin = join(parent, 'fake-bin')
    await mkdir(fakeBin)
    const fakeClaude = join(fakeBin, 'claude')
    await Bun.write(
      fakeClaude,
      [
        '#!/bin/sh',
        `printf '%s\\n' '{"type":"assistant","message":{"content":"synthetic-secret"}}'`,
        `printf '%s\\n' '{"type":"result","result":"{}"}'`,
        `printf '%s\\n' 'fake stderr' >&2`,
      ].join('\n')
    )
    await chmod(fakeClaude, 0o755)
    prepared.provisioned.childEnv.PATH = `${fakeBin}:${prepared.provisioned.childEnv.PATH}`
    expect(await capturePilot(prepared, 'local-model-id')).toBe(0)
    const raw = await Bun.file(prepared.rawTracePath).text()
    expect(raw).toBe(
      '{"type":"assistant","message":{"content":"synthetic-secret"}}\n' +
        '{"type":"result","result":"{}"}\n'
    )
    expect(await Bun.file(prepared.stderrPath).text()).toBe('fake stderr\n')
    expect(await readdir(prepared.agentDir)).toEqual(['continuation.html'])
    const shapes = JSON.stringify(inspectStreamShapes(raw))
    expect(shapes).toContain('message.content:string')
    expect(shapes).not.toContain('synthetic-secret')
  })

  test('inspector redacts dynamic model keys and groups repeated event shapes', () => {
    const raw = [
      JSON.stringify({
        type: 'result',
        modelUsage: {
          'private-model-route': {
            inputTokens: 12,
            outputTokens: 4,
          },
        },
        result: '{"records":[]}',
      }),
      JSON.stringify({
        type: 'result',
        modelUsage: {
          'another-private-route': {
            inputTokens: 8,
            outputTokens: 3,
          },
        },
        result: '{"records":[]}',
      }),
    ].join('\n')

    const shapes = inspectStreamShapes(raw)
    expect(shapes).toEqual([
      {
        type: 'result',
        count: 2,
        paths: [
          '$:object',
          'modelUsage.<model>.inputTokens:number',
          'modelUsage.<model>.outputTokens:number',
          'modelUsage.<model>:object',
          'modelUsage:object',
          'result:string',
          'type:string',
        ],
      },
    ])
    const serialized = JSON.stringify(shapes)
    expect(serialized).not.toContain('private-model-route')
    expect(serialized).not.toContain('another-private-route')
    // Spawns the fake-claude runner end to end — same headroom as above.
  }, 30_000)
})
