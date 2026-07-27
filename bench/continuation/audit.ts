import { basename, resolve } from 'node:path'
import type { NormalizedToolCall } from './stream'
import type { AxInvocation } from './telemetry'

export type ToolContextAudit = {
  status: 'pass' | 'violation' | 'not_gradable'
  issues: string[]
  alternativeStrategy: 'direct-fixture-read' | null
}

type SimpleCommand = {
  argv: string[]
}

type ShellClassification =
  | { status: 'parsed'; commands: SimpleCommand[] }
  | { status: 'unsupported' }

const DIRECT_READ_COMMANDS = new Set([
  'awk',
  'cat',
  'cp',
  'dd',
  'grep',
  'head',
  'perl',
  'python',
  'python3',
  'rg',
  'ruby',
  'sed',
  'tail',
])

function stringTargetsFixture(value: string, fixtureBasename: string): boolean {
  if (value.includes(fixtureBasename)) return true
  const pattern = value.split('/').at(-1) ?? value
  if (!pattern.includes('*') && !pattern.includes('?')) return false
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')
  return new RegExp(`^${expression}$`).test(fixtureBasename)
}

function targetsFixture(value: unknown, fixtureBasename: string): boolean {
  if (typeof value === 'string') return stringTargetsFixture(value, fixtureBasename)
  if (Array.isArray(value)) {
    return value.some((item) => targetsFixture(item, fixtureBasename))
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => targetsFixture(item, fixtureBasename))
  }
  return false
}

function pathTargetsFixture(
  value: unknown,
  fixtureBasename: string,
  fixtureDirectory: string | undefined
): boolean {
  if (targetsFixture(value, fixtureBasename)) return true
  return (
    typeof value === 'string' &&
    (value === '.' ||
      (fixtureDirectory !== undefined && resolve(value) === resolve(fixtureDirectory)))
  )
}

function directToolTargetsFixture(
  call: NormalizedToolCall,
  fixtureBasename: string,
  fixtureDirectory: string | undefined
): boolean {
  if (call.name === 'Read') {
    return pathTargetsFixture(
      call.input.file_path ?? call.input.path,
      fixtureBasename,
      fixtureDirectory
    )
  }
  if (call.name === 'Grep') {
    const path = call.input.path
    return path === undefined || pathTargetsFixture(path, fixtureBasename, fixtureDirectory)
  }
  if (call.name === 'Glob') {
    return targetsFixture(call.input.pattern, fixtureBasename)
  }
  return false
}

function commandHasFixtureHint(command: string, fixtureBasename: string): boolean {
  return command
    .split(/\s+/)
    .some((token) => stringTargetsFixture(token.replace(/^['"]|['"]$/g, ''), fixtureBasename))
}

function isSafeNonFixtureCommand(command: SimpleCommand): boolean {
  const executable = basename(command.argv[0]!)
  const args = command.argv.slice(1)
  if (executable === 'command') return JSON.stringify(args) === JSON.stringify(['-v', 'ax'])
  if (executable === 'which') return JSON.stringify(args) === JSON.stringify(['ax'])
  if (executable === 'ax') return args.length === 1 && ['--help', '--version'].includes(args[0]!)
  return executable === 'echo'
}

function isSafeUnsupportedNonFixtureCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed === 'command -v ax && ax --help | head -20') return true
  return /^echo\s+"[^"$`\\]*(?:\$\(\([0-9+\-*/%\s()]+\)\))?[^"$`\\]*"$/.test(trimmed)
}

function parseSimpleCommandList(command: string): ShellClassification {
  const commands: SimpleCommand[] = []
  let argv: string[] = []
  let token = ''
  let tokenStarted = false
  let quote: "'" | '"' | null = null

  const pushToken = () => {
    if (!tokenStarted) return
    argv.push(token)
    token = ''
    tokenStarted = false
  }
  const pushCommand = () => {
    pushToken()
    if (argv.length === 0) return false
    commands.push({ argv })
    argv = []
    return true
  }

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote) {
      if (char === quote) {
        quote = null
        tokenStarted = true
        continue
      }
      if (quote === '"' && char === '\\') {
        const next = command[++index]
        if (next === undefined) return { status: 'unsupported' }
        token += next
        tokenStarted = true
        continue
      }
      if (char === '`' || (char === '$' && command[index + 1] === '(')) {
        return { status: 'unsupported' }
      }
      token += char
      tokenStarted = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      tokenStarted = true
      continue
    }
    if (char === '\\') {
      const next = command[++index]
      if (next === undefined) return { status: 'unsupported' }
      token += next
      tokenStarted = true
      continue
    }
    if (/\s/.test(char)) {
      if (char === '\n' || char === '\r') return { status: 'unsupported' }
      pushToken()
      continue
    }
    if (char === ';') {
      if (!pushCommand()) return { status: 'unsupported' }
      continue
    }
    if (char === '&' && command[index + 1] === '&') {
      if (!pushCommand()) return { status: 'unsupported' }
      index++
      continue
    }
    if (
      char === '|' ||
      char === '<' ||
      char === '>' ||
      char === '`' ||
      char === '(' ||
      char === ')' ||
      char === '&'
    ) {
      return { status: 'unsupported' }
    }
    if (char === '$' && command[index + 1] === '(') return { status: 'unsupported' }
    token += char
    tokenStarted = true
  }
  if (quote || !pushCommand()) return { status: 'unsupported' }
  return { status: 'parsed', commands }
}

function fixtureInvocations(invocations: AxInvocation[], fixtureBasename: string): AxInvocation[] {
  return invocations.filter((call) =>
    call.argv.some((arg) => arg === fixtureBasename || arg.endsWith(`/${fixtureBasename}`))
  )
}

function result(
  status: ToolContextAudit['status'],
  issues: string[],
  alternativeStrategy: ToolContextAudit['alternativeStrategy'] = null
): ToolContextAudit {
  return { status, issues: [...new Set(issues)], alternativeStrategy }
}

export function auditToolContext(
  toolCalls: NormalizedToolCall[],
  invocations: AxInvocation[],
  fixtureBasename = 'continuation.html',
  fixtureDirectory?: string
): ToolContextAudit {
  const expectedArgv: string[][] = []
  let unsupportedFixtureCommand = false
  let unverifiableNonAxCommand = false

  for (const call of toolCalls) {
    if (call.name === 'Read' || call.name === 'Grep' || call.name === 'Glob') {
      if (directToolTargetsFixture(call, fixtureBasename, fixtureDirectory)) {
        return result('violation', ['direct fixture access'], 'direct-fixture-read')
      }
      continue
    }
    if (call.name !== 'Bash') {
      if (targetsFixture(call.input, fixtureBasename)) unsupportedFixtureCommand = true
      continue
    }
    if (typeof call.input.command !== 'string') {
      if (targetsFixture(call.input, fixtureBasename)) unsupportedFixtureCommand = true
      continue
    }
    const commandText = call.input.command
    const parsed = parseSimpleCommandList(commandText)
    if (parsed.status === 'unsupported') {
      if (commandHasFixtureHint(commandText, fixtureBasename)) {
        unsupportedFixtureCommand = true
      } else if (!isSafeUnsupportedNonFixtureCommand(commandText)) {
        unverifiableNonAxCommand = true
      }
      continue
    }
    const fixtureAxCommands = parsed.commands.filter((command) => {
      const executable = basename(command.argv[0]!)
      return (
        executable === 'ax' &&
        command.argv
          .slice(1)
          .some((arg) => pathTargetsFixture(arg, fixtureBasename, fixtureDirectory))
      )
    })
    if (fixtureAxCommands.length > 0 && parsed.commands.length !== 1) {
      unsupportedFixtureCommand = true
    }
    for (const command of parsed.commands) {
      const executable = basename(command.argv[0]!)
      const fixtureAssignment =
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.argv[0]!) &&
        stringTargetsFixture(command.argv[0]!, fixtureBasename)
      const argumentsTargetFixture =
        fixtureAssignment ||
        command.argv
          .slice(1)
          .some((arg) => pathTargetsFixture(arg, fixtureBasename, fixtureDirectory)) ||
        (DIRECT_READ_COMMANDS.has(executable) && command.argv.slice(1).includes('.'))
      if (!argumentsTargetFixture) {
        if (!isSafeNonFixtureCommand(command)) unverifiableNonAxCommand = true
        continue
      }
      if (executable === 'ax') {
        const unresolved =
          call.isError &&
          call.resultText.startsWith('Exit code 127\n') &&
          call.resultText.endsWith(`no such file or directory: ${command.argv[0]}`)
        if (unresolved) continue
        expectedArgv.push(command.argv.slice(1))
        continue
      }
      if (executable === 'ls') {
        return result('violation', ['fixture access outside ax'])
      }
      if (DIRECT_READ_COMMANDS.has(executable) || fixtureAssignment) {
        return result('violation', ['direct fixture access'], 'direct-fixture-read')
      }
      unsupportedFixtureCommand = true
    }
  }

  if (unsupportedFixtureCommand) {
    return result('not_gradable', ['unsupported fixture-targeting Bash command'])
  }
  if (unverifiableNonAxCommand) {
    return result('not_gradable', ['unverifiable non-ax Bash command'])
  }
  const actualArgv = fixtureInvocations(invocations, fixtureBasename).map((call) => call.argv)
  if (
    expectedArgv.length !== actualArgv.length ||
    expectedArgv.some((argv, index) => JSON.stringify(argv) !== JSON.stringify(actualArgv[index]))
  ) {
    return result('not_gradable', ['fixture ax telemetry mismatch'])
  }
  return result('pass', [])
}
