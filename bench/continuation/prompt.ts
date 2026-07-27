export type SkillMode = 'none' | 'guided' | 'ablated'

const CONTINUATION_GUIDANCE_BLOCK = [
  '- For automated continuation, use `--json-envelope`. Read `data`; when',
  '  `meta.state` is `more`, rerun the same command with',
  '  `--offset <meta.next_offset>`. Continue only while it is `more`; stop on',
  '  `complete` or `past_end`; do not restart from zero or increase the budget.',
].join('\n')

function skillBody(markdown: string): string {
  const closing = markdown.indexOf('\n---', 4)
  if (!markdown.startsWith('---\n') || closing === -1) {
    throw new Error('Skill must contain YAML frontmatter')
  }
  return markdown.slice(closing + 4).replace(/^\n+/, '')
}

export function renderContinuationPrompt(template: string, budget: number): string {
  const matches = template.match(/\{\{BUDGET\}\}/g) ?? []
  if (matches.length !== 1) throw new Error('prompt must contain exactly one {{BUDGET}}')
  return template.replace('{{BUDGET}}', String(budget)).trim()
}

export function ablateContinuationGuidance(markdown: string): string {
  const target = `${CONTINUATION_GUIDANCE_BLOCK}\n`
  const matches = markdown.split(target).length - 1
  if (matches !== 1) throw new Error('Skill must contain exactly one continuation bullet')
  return markdown.replace(target, '')
}

export function applySkill(prompt: string, skillMarkdown: string, mode: SkillMode): string {
  if (mode === 'none') return prompt
  const selected = mode === 'guided' ? skillMarkdown : ablateContinuationGuidance(skillMarkdown)
  return `${skillBody(selected)}\n\n${prompt}`
}
