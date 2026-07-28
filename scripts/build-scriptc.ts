// Compile ax to a native binary with scriptc (https://scriptc.dev).
//
// The sources are staged into a build directory first so `src/lib/platform.ts`
// can be replaced by its compiled-binary counterpart. The swap has to happen
// before the compiler sees the file: scriptc refuses TextDecoder labels and
// the two-argument process.stdout.write at COMPILE time, and neither
// `globalThis` nor `process` can be aliased into a dynamic value to reach them
// another way — so a runtime branch is not an option.
//
// --dynamic embeds the JS engine that linkedom and fetch run in (~620KB) and
// needs cmake plus a C toolchain on PATH the first time; the engine archive is
// cached afterwards.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { $ } from 'bun'

const repo = join(import.meta.dir, '..')
const stage = join(repo, '.scriptc-build')
const out = process.argv[2] ?? join(repo, 'ax')

rmSync(out, { force: true })
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// The staging dir sits inside the repo so `linkedom` still resolves through
// the repo's node_modules, and `src/index.ts`'s `../package.json` import
// resolves to the copy placed beside it.
cpSync(join(repo, 'src'), join(stage, 'src'), { recursive: true })
cpSync(join(repo, 'package.json'), join(stage, 'package.json'))
cpSync(join(repo, 'tsconfig.json'), join(stage, 'tsconfig.json'))
cpSync(join(stage, 'src', 'lib', 'platform.scriptc.ts'), join(stage, 'src', 'lib', 'platform.ts'))
rmSync(join(stage, 'src', 'lib', 'platform.scriptc.ts'))

await $`bun run ${join(repo, 'scripts', 'gen-agent-context.ts')}`
cpSync(join(repo, 'src', 'agent-context.gen.ts'), join(stage, 'src', 'agent-context.gen.ts'))

// Invoked through `node` explicitly rather than by shebang: Bun's $ runs a JS
// entry point in-process, and scriptc's compiler needs Node — typescript@7's
// synchronous RPC channel reads `stdout._handle.fd` off a spawned child, which
// Bun does not expose.
const cli = join(repo, 'node_modules', 'scriptc', 'dist', 'main.js')
await $`node ${cli} build ${join(stage, 'src', 'index.ts')} -o ${out} --dynamic --no-keep-c`

process.stderr.write(`built ${out}\n`)
