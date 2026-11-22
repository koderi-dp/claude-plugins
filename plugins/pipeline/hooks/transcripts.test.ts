import { expect, test } from 'claude-code/testing'

import { digest, indexMd, safeName, sessionFolder } from './transcripts'
import type { SessionRecord } from './transcripts'

const line = (o: unknown) => JSON.stringify(o)

test('safeName and sessionFolder: one folder per session, under the project, named by when it started and its id', () => {
  expect(safeName('  my app / v2 ')).toBe('my-app-v2')
  expect(safeName('***')).toBe('unnamed')
  const at = new Date(2026, 10, 22, 9, 31).getTime()
  expect(sessionFolder('C:\\Users\\me\\.claude\\plugins\\data\\pipeline\\', 'docklet', '6909f5ea-3085-4199-a91d-b3e447ff192c', at)).toBe('C:/Users/me/.claude/plugins/data/pipeline/transcripts/docklet/2026-11-22_0931_6909f5ea')
})

test('digest: prompts, what the model said, tool calls with their input and result, in order; long results clipped, bad lines skipped', () => {
  const text = [
    line({ type: 'user', timestamp: '2026-11-22T09:31:00Z', message: { role: 'user', content: 'Run the first ready item.' } }),
    'not json',
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Claiming item 31.' }, { type: 'tool_use', id: 't1', name: 'mcp__pipeline__pipeline', input: { action: 'begin' } }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '31 · planning · branch feat/31' }] } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'x'.repeat(2000) }] }] } }),
  ].join('\n')
  const md = digest(text, 'docklet · #31 · Edit a filter')
  expect(md.startsWith('# docklet · #31 · Edit a filter\n\n2 tool calls · 1 error\n')).toBe(true)
  expect(md).toContain('## Prompt · 2026-11-22T09:31:00Z\n\nRun the first ready item.')
  expect(md).toContain('**Claude:** Claiming item 31.')
  expect(md).toContain('### mcp__pipeline__pipeline')
  expect(md).toContain('"action": "begin"')
  expect(md).toContain('Result:\n\n```\n31 · planning · branch feat/31\n```')
  expect(md).toContain('**Result (error):**')
  expect(md).toContain('… (500 more characters, in the .jsonl)')
  expect(md).not.toContain('hidden')
  // The order is the transcript's.
  expect(md.indexOf('Claiming item 31')).toBeLessThan(md.indexOf('### Bash'))
})

test('indexMd: one row per saved session, the newest first, with what it was called and the items it ran', () => {
  const rec = (folder: string, startedAt: string, name: string, items: string[]): SessionRecord => ({ folder, project: 'docklet', cwd: 'C:/p/docklet', sessionId: folder, name, items, pluginVersion: '0.7.0', startedAt, updatedAt: startedAt, source: 'x.jsonl', subagents: items.length })
  const md = indexMd('docklet', [rec('2026-11-21_1000_aaaa', '2026-11-21T10:00:00Z', '#30 · Old | one', ['30']), rec('2026-11-22_0931_bbbb', '2026-11-22T09:31:00Z', '', [])])
  const rows = md.split('\n').filter(l => l.startsWith('| ['))
  expect(rows).toEqual([
    '| [2026-11-22_0931_bbbb](2026-11-22_0931_bbbb/session.md) | - | - | 0 | 2026-11-22T09:31:00Z |',
    '| [2026-11-21_1000_aaaa](2026-11-21_1000_aaaa/session.md) | #30 · Old / one | 30 | 1 | 2026-11-21T10:00:00Z |',
  ])
})
