// The panel's views, drawn from plain data with the surface's own elements.
// One tree for terminal and desktop: Box, Text and Button only.
import type { EngineInterface } from 'claude-code'

import type { AgentRun, NativeTask } from '../types'
import { elapsed, shortModel } from './board'
import type { Others } from './live'

export type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Element = ReturnType<typeof h>

export const RUNNING = '#8f8cf4'
export const DONE = '#5fbf8f'
export const BLOCKED = '#e8a33c'

export const FINISHED_SHOWN = 8

/** What the Now view keeps when it is drawn inside a milestone. */
export type NowFilter = { id: string; titles: string[] }

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export function renderNow(ui: Ui, d: { agents: AgentRun[]; tasks: NativeTask[]; others: Others; at: number; filter?: NowFilter }): Element {
  const { Box, Text } = ui as unknown as { Box: (p: object) => Element; Text: (p: object) => Element }
  const f = d.filter
  const agents = f ? d.agents.filter(a => f.titles.some(t => t && a.name.includes(t))) : d.agents
  const others = f ? d.others.filter(o => o.item?.startsWith(`${f.id}/`)) : d.others
  const tasks = f ? [] : [...d.tasks].sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress'))
  const running = agents.filter(a => a.status === 'running')
  const finished = agents.filter(a => a.status !== 'running')
  const shown = finished.slice(-FINISHED_SHOWN).reverse()
  const head = (text: string) => <Text dimColor>{text}</Text>

  if (!tasks.length && !agents.length && !others.length) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{f ? 'Nothing running on this milestone.' : 'Nothing running. /board status prints this as text.'}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {tasks.length > 0 && head('Tasks')}
      {tasks.map(t => (
        <Box flexDirection="row">
          <Text color={t.status === 'in_progress' ? RUNNING : t.status === 'completed' ? DONE : undefined} dimColor={t.status === 'pending'}>
            {t.status === 'in_progress' ? '●' : t.status === 'completed' ? '✓' : '○'}
          </Text>
          <Text wrap="truncate-end" dimColor={t.status === 'completed'}>
            {` ${t.subject}`}
          </Text>
        </Box>
      ))}
      {agents.length > 0 && head(`Agents · ${running.length} running`)}
      {running.map(a => (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text color={RUNNING}>●</Text>
            <Text wrap="truncate-end">{` ${a.name}`}</Text>
            <Text dimColor>{` ${shortModel(a.model)} · ${elapsed(d.at - a.startedAt)}`}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{`  ▶ ${a.activity}`}</Text>
        </Box>
      ))}
      {shown.map(a => (
        <Box flexDirection="row">
          <Text color={a.status === 'done' ? DONE : BLOCKED}>{a.status === 'done' ? '✓' : '✗'}</Text>
          <Text dimColor wrap="truncate-end">{` ${a.name}`}</Text>
          <Text dimColor>{` ${elapsed((a.endedAt ?? d.at) - a.startedAt)} · ${plural(a.calls, 'call')}`}</Text>
        </Box>
      ))}
      {finished.length > FINISHED_SHOWN && <Text dimColor>{`+${finished.length - FINISHED_SHOWN} · /board status`}</Text>}
      {others.length > 0 && head('Sessions')}
      {others.map(o => {
        const latest = o.agents[o.agents.length - 1]
        const sub = [o.branch, o.item, o.agents.length ? plural(o.agents.length, 'agent') : '', latest?.activity, o.isQuiet ? 'quiet' : ''].filter(Boolean).join(' · ')
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text color={o.isQuiet ? undefined : RUNNING} dimColor={o.isQuiet}>
                {o.isQuiet ? '◌' : '●'}
              </Text>
              <Text wrap="truncate-end">{` ${o.title}`}</Text>
            </Box>
            {sub && <Text dimColor wrap="truncate-end">{`  ${sub}`}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}
