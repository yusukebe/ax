import { join } from 'node:path'

export const CONTINUATION_SEED = 0x53a11
export const CONTINUATION_BUDGET = 600
export const CONTINUATION_SELECTOR = '.incident'
export const CONTINUATION_ROW_SPEC = 'id=@data-id,owner=.owner,severity=.severity,status=.status'

export type IncidentRecord = {
  id: string
  owner: string
  severity: 'S1' | 'S2' | 'S3' | 'S4'
  status: 'open' | 'investigating' | 'mitigated' | 'closed'
}

export type GeneratedFixture = {
  html: string
  records: IncidentRecord[]
}

const owners = [
  'atlas-ops',
  'beacon-api',
  'cobalt-web',
  'delta-data',
  'ember-edge',
  'fjord-payments',
] as const
const severities = ['S1', 'S2', 'S3', 'S4'] as const
const statuses = ['open', 'investigating', 'mitigated', 'closed'] as const

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!
}

export function generateFixture(seed = CONTINUATION_SEED): GeneratedFixture {
  const random = mulberry32(seed)
  const ids = Array.from(
    { length: 120 },
    (_, index) => `INC-${String(73001 + index).padStart(5, '0')}`
  )
  for (let index = ids.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[ids[index], ids[swap]] = [ids[swap]!, ids[index]!]
  }
  const records = ids.map((id) => ({
    id,
    owner: pick(owners, random),
    severity: pick(severities, random),
    status: pick(statuses, random),
  }))
  const incidents = records.map(
    (record) =>
      `<article class="incident" data-id="${record.id}">` +
      `<span class="owner">${record.owner}</span>` +
      `<span class="severity">${record.severity}</span>` +
      `<span class="status">${record.status}</span>` +
      `</article>`
  )
  const previews = Array.from(
    { length: 12 },
    (_, index) =>
      `<article class="incident-preview" data-id="PRE-${index}">` +
      `<span class="owner">preview</span>` +
      `<span class="severity">S1</span>` +
      `<span class="status">open</span>` +
      `</article>`
  )
  return {
    records,
    html: `<!doctype html><html><body>\n${[...incidents, ...previews].join('\n')}\n</body></html>\n`,
  }
}

export async function writeAgentFixture(
  agentDir: string,
  seed = CONTINUATION_SEED
): Promise<IncidentRecord[]> {
  const fixture = generateFixture(seed)
  await Bun.write(join(agentDir, 'continuation.html'), fixture.html)
  return fixture.records
}
