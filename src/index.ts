#!/usr/bin/env bun
import agentContext from './agent-context.txt' with { type: 'text' }
import { root, rootHelp } from './commands/root'

const VERSION = '0.1.9'

async function main() {
  const argv = process.argv.slice(2)
  const [first] = argv

  if (!first || first === '--help' || first === '-h' || first === 'help') {
    console.log(rootHelp)
    return
  }
  if (first === '--version' || first === '-v') {
    console.log(VERSION)
    return
  }
  if (first === 'agent-context') {
    console.log(agentContext)
    return
  }

  await root(argv)
}

main()
