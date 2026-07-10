import { test, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

// The installer must refuse to install anything that fails SHA-256
// verification, and must never damage an existing ax on failure.

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'install.sh')

const os = process.platform === 'darwin' ? 'darwin' : 'linux'
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const ASSET = `ax-${os}-${arch}`

// A fake "binary" that survives the installer's final `ax --version` check.
const FAKE_BIN = '#!/bin/sh\necho 9.9.9\n'
const GOOD_SHA = new Bun.CryptoHasher('sha256').update(FAKE_BIN).digest('hex')

let server: ReturnType<typeof Bun.serve>
let badChecksums = false
let emptyChecksums = false

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname
      if (p.endsWith(`/${ASSET}`)) return new Response(FAKE_BIN)
      if (p.endsWith('/checksums.txt')) {
        if (emptyChecksums) return new Response(`${GOOD_SHA}  some-other-asset\n`)
        const sha = badChecksums ? 'deadbeef'.repeat(8) : GOOD_SHA
        return new Response(`${sha}  ${ASSET}\n`)
      }
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => server.stop(true))

async function runInstaller(dir: string) {
  const proc = Bun.spawn(['sh', SCRIPT], {
    env: {
      ...process.env,
      AX_INSTALL_DIR: dir,
      AX_VERSION: 'v9.9.9',
      AX_DOWNLOAD_BASE: `http://localhost:${server.port}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { out, err, code: await proc.exited }
}

test('installer: verifies SHA-256 and installs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ax-inst-'))
  badChecksums = false
  const r = await runInstaller(dir)
  expect(r.out).toContain('SHA-256 verified')
  expect(r.out).toContain('9.9.9')
  expect(r.code).toBe(0)
  expect(await Bun.file(join(dir, 'ax')).text()).toBe(FAKE_BIN)
})

test('installer: refuses a checksum mismatch and keeps the existing ax intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ax-inst-'))
  writeFileSync(join(dir, 'ax'), 'PRECIOUS-EXISTING-BINARY')
  badChecksums = true
  const r = await runInstaller(dir)
  expect(r.code).not.toBe(0)
  expect(r.err).toContain('SHA-256 mismatch')
  expect(r.err).toContain('refusing to install')
  // The existing binary is untouched and no temp debris is left behind.
  expect(await Bun.file(join(dir, 'ax')).text()).toBe('PRECIOUS-EXISTING-BINARY')
  expect(readdirSync(dir).filter((n) => n !== 'ax')).toEqual([])
})

test('installer: refuses when the asset is missing from checksums.txt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ax-inst-'))
  badChecksums = false
  emptyChecksums = true
  const r = await runInstaller(dir)
  emptyChecksums = false
  expect(r.code).not.toBe(0)
  expect(r.err).toContain('not found in checksums.txt')
  expect(await Bun.file(join(dir, 'ax')).exists()).toBe(false)
})
