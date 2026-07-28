#!/usr/bin/env bun
import { agentContext } from './agent-context.gen'
import pkg from './../package.json'
import { root, rootHelp } from './commands/root'

async function main() {
  const argv = process.argv.slice(2)
  const first = argv.length > 0 ? argv[0] : undefined

  if (!first || first === '--help' || first === '-h' || first === 'help') {
    console.log(rootHelp)
    return
  }
  if (first === '--version' || first === '-v') {
    console.log(pkg.version)
    return
  }
  if (first === 'agent-context') {
    console.log(agentContext)
    return
  }

  await root(argv)
}

main()
