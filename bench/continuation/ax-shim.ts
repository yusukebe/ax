#!/usr/bin/env bun
import { closeSync, openSync, writeSync } from 'node:fs'
import type { AxInvocation } from './telemetry'

const real = process.env.AX_BENCH_REAL
const telemetry = process.env.AX_BENCH_TELEMETRY
if (!real || !telemetry) {
  console.error('ax benchmark shim: missing AX_BENCH_REAL or AX_BENCH_TELEMETRY')
  process.exit(70)
}

const startedAtMs = performance.timeOrigin + performance.now()
const proc = Bun.spawn([real, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdout: 'pipe',
  stderr: 'pipe',
})
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).arrayBuffer(),
  new Response(proc.stderr).arrayBuffer(),
  proc.exited,
])
const out = new Uint8Array(stdout)
const err = new Uint8Array(stderr)
const record: AxInvocation = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: new TextDecoder().decode(out),
  stderr: new TextDecoder().decode(err),
  exitCode,
  startedAtMs,
  endedAtMs: performance.timeOrigin + performance.now(),
}
const fd = openSync(telemetry, 'a', 0o600)
try {
  writeSync(fd, `${JSON.stringify(record)}\n`)
} finally {
  closeSync(fd)
}
if (out.length) await new Promise<void>((resolve) => process.stdout.write(out, () => resolve()))
if (err.length) await new Promise<void>((resolve) => process.stderr.write(err, () => resolve()))
process.exit(exitCode)
