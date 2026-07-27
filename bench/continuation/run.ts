import { chmod, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONTINUATION_BUDGET,
  CONTINUATION_SEED,
  type IncidentRecord,
  writeAgentFixture,
} from './fixture'
import { applySkill, renderContinuationPrompt, type SkillMode } from './prompt'

export type Condition = 'conformance' | 'adoption-guided' | 'adoption-ablated'

export type SafeRunManifest = {
  schemaVersion: 1
  condition: Condition
  publicModel: 'Sonnet 5'
  seed: number
  budget: number
}

export type ProvisionedAx = {
  axPath: string
  realPath: string
  telemetryPath: string
  childEnv: Record<string, string>
}

export type PreparedRun = {
  runRoot: string
  agentDir: string
  prompt: string
  truth: IncidentRecord[]
  provisioned: ProvisionedAx
  rawTracePath: string
  stderrPath: string
}

export async function provisionAx(repoRoot: string, runRoot: string): Promise<ProvisionedAx> {
  const binDir = join(runRoot, 'bin')
  const telemetryDir = join(runRoot, 'telemetry')
  await mkdir(binDir)
  await mkdir(telemetryDir)
  const realPath = join(binDir, 'ax-real')
  const axPath = join(binDir, 'ax')
  const telemetryPath = join(telemetryDir, 'ax.jsonl')
  const build = Bun.spawnSync(
    ['bun', 'build', join(repoRoot, 'src/index.ts'), '--compile', '--outfile', realPath],
    { cwd: repoRoot }
  )
  if (build.exitCode !== 0) throw new Error(build.stderr.toString())
  const shimSource = fileURLToPath(new URL('./ax-shim.ts', import.meta.url))
  await Bun.write(axPath, `#!/bin/sh\nexec bun "${shimSource}" "$@"\n`)
  await chmod(axPath, 0o755)
  const childEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    AX_BENCH_REAL: realPath,
    AX_BENCH_TELEMETRY: telemetryPath,
  } as Record<string, string>
  const resolved = Bun.spawnSync(['sh', '-c', 'command -v ax'], { env: childEnv })
  if (resolved.exitCode !== 0 || resolve(resolved.stdout.toString().trim()) !== resolve(axPath)) {
    throw new Error('child PATH did not resolve the benchmark ax shim')
  }
  return { axPath, realPath, telemetryPath, childEnv }
}

export async function preflightAx(provisioned: ProvisionedAx, fixturePath: string): Promise<void> {
  const base = [
    fixturePath,
    '.incident',
    '--row',
    'id=@data-id,owner=.owner,severity=.severity,status=.status',
    '--json-envelope',
    '--limit',
    '1',
  ]
  const first = Bun.spawnSync(['ax', ...base], { env: provisioned.childEnv })
  if (first.exitCode !== 0) throw new Error(first.stderr.toString())
  const firstPage = JSON.parse(first.stdout.toString())
  if (firstPage.meta.returned !== 1 || firstPage.meta.next_offset !== 1) {
    throw new Error('first envelope failed preflight')
  }
  const second = Bun.spawnSync(['ax', ...base, '--offset', '1'], {
    env: provisioned.childEnv,
  })
  if (second.exitCode !== 0) throw new Error(second.stderr.toString())
  const secondPage = JSON.parse(second.stdout.toString())
  if (secondPage.meta.offset !== 1 || secondPage.data[0]?.id === firstPage.data[0]?.id) {
    throw new Error('second envelope overlapped preflight page')
  }
  await Bun.write(provisioned.telemetryPath, '')
}

export async function assertExternalRunRoot(
  repoRootInput: string,
  runRootInput: string
): Promise<string> {
  const repoRoot = await realpath(repoRootInput)
  const requested = resolve(runRootInput)
  const parent = await realpath(dirname(requested))
  const runRoot = join(parent, basename(requested))
  const fromRepo = relative(repoRoot, runRoot)
  const insideRepo =
    fromRepo === '' ||
    (fromRepo !== '..' && !fromRepo.startsWith(`..${sep}`) && !isAbsolute(fromRepo))
  if (insideRepo) throw new Error('run-root must be outside the repository')
  return runRoot
}

function conditionFiles(condition: Condition): {
  promptUrl: URL
  skillMode: SkillMode
} {
  if (condition === 'conformance') {
    return {
      promptUrl: new URL('../prompts/continuation-conformance.txt', import.meta.url),
      skillMode: 'none',
    }
  }
  return {
    promptUrl: new URL('../prompts/continuation-adoption.txt', import.meta.url),
    skillMode: condition === 'adoption-guided' ? 'guided' : 'ablated',
  }
}

export async function prepareRun(runRootInput: string, condition: Condition): Promise<PreparedRun> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const runRoot = await assertExternalRunRoot(repoRoot, runRootInput)
  await mkdir(runRoot, { recursive: false })
  const manifest: SafeRunManifest = {
    schemaVersion: 1,
    condition,
    publicModel: 'Sonnet 5',
    seed: CONTINUATION_SEED,
    budget: CONTINUATION_BUDGET,
  }
  await Bun.write(join(runRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const agentDir = join(runRoot, 'agent')
  await mkdir(agentDir)
  const truth = await writeAgentFixture(agentDir)
  const { promptUrl, skillMode } = conditionFiles(condition)
  const template = await Bun.file(promptUrl).text()
  const skill = await Bun.file(new URL('../../skills/ax/SKILL.md', import.meta.url)).text()
  const rendered = renderContinuationPrompt(template, CONTINUATION_BUDGET)
  const prompt = applySkill(rendered, skill, skillMode)
  const provisioned = await provisionAx(repoRoot, runRoot)
  await preflightAx(provisioned, join(agentDir, 'continuation.html'))
  return {
    runRoot,
    agentDir,
    prompt,
    truth,
    provisioned,
    rawTracePath: join(runRoot, 'stream.jsonl'),
    stderrPath: join(runRoot, 'claude.stderr.log'),
  }
}

export function buildClaudeArgs(model: string, prompt: string): string[] {
  return [
    'claude',
    '-p',
    prompt,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    'Bash,Read,Grep,Glob',
    '--max-turns',
    '40',
  ]
}

export async function capturePilot(prepared: PreparedRun, model: string): Promise<number> {
  const proc = Bun.spawn(buildClaudeArgs(model, prepared.prompt), {
    cwd: prepared.agentDir,
    env: prepared.provisioned.childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).arrayBuffer(),
    proc.exited,
  ])
  await Promise.all([
    Bun.write(prepared.rawTracePath, new Uint8Array(stdout)),
    Bun.write(prepared.stderrPath, new Uint8Array(stderr)),
  ])
  return exitCode
}

export function parseCondition(value: string | undefined): Condition {
  if (value === 'conformance' || value === 'adoption-guided' || value === 'adoption-ablated') {
    return value
  }
  throw new Error('condition must be conformance, adoption-guided, or adoption-ablated')
}

if (import.meta.main) {
  const [runRoot, conditionValue] = process.argv.slice(2)
  const model = process.env.AX_BENCH_MODEL
  if (!model) throw new Error('AX_BENCH_MODEL is required')
  if (!runRoot) throw new Error('run-root is required')
  const condition = parseCondition(conditionValue)
  const prepared = await prepareRun(runRoot, condition)
  const exitCode = await capturePilot(prepared, model)
  console.log(
    JSON.stringify(
      {
        condition,
        exitCode,
        runRoot: prepared.runRoot,
        rawTracePath: prepared.rawTracePath,
        telemetryPath: prepared.provisioned.telemetryPath,
      },
      null,
      2
    )
  )
  process.exit(exitCode)
}
