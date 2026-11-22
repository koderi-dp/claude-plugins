import { expect, test } from 'claude-code/testing'

import { heroSvg } from './draw'
import type { Hero } from './draw'
import type { Step } from './status'

const steps = (at: number): Step[] => (['Plan', 'Build', 'Review', 'Merge'] as const).map((name, i) => ({ name, state: i < at ? 'done' : i === at ? 'current' : 'pending' }))
const hero = (done: number, total: number, at: number): Hero => ({ kind: 'running', state: 'BUILDING · #31', headline: 'Edit the text of a log filter', line: 'A line.', progress: { done, total }, steps: steps(at) })
const percentOf = (h: Hero) => />(\d+)%</.exec(heroSvg(480, h).source)?.[1]

test('0.6.5: every task accepted with the final review running is not 100%: the bar ends under the current step', () => {
  // As seen in a run: 2 of 2 tasks accepted, Review current, Merge pending.
  const svg = heroSvg(480, hero(2, 2, 2)).source
  expect(svg).toContain('2 of 2 tasks accepted')
  expect(percentOf(hero(2, 2, 2))).toBe('67')
})

test('0.6.5: the accepted tasks carry the bar across the Build step; only a merged item is 100%', () => {
  expect(percentOf(hero(0, 3, 0))).toBe('0')
  expect(percentOf(hero(0, 3, 1))).toBe('33')
  expect(percentOf(hero(1, 3, 1))).toBe('44')
  expect(percentOf(hero(3, 3, 1))).toBe('67')
  expect(percentOf(hero(3, 3, 3))).toBe('100')
  expect(percentOf(hero(3, 3, 4))).toBe('100')
})
