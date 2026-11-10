// Renders every fixture state through the real renderPanel with the HTML element table, to out/<state>.html;
// under a running or fix-round panel the band, under the idle one the idle strip, as the AbovePrompt hook draws them.
// Run: tsc -p plugins/pipeline/preview && node plugins/pipeline/preview/out/build/preview/render.js

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BAND_H, BAND_COMPACT_H, bandSvg, idleStripSvg } from '../hooks/draw'
import { renderPanel } from '../hooks/pane'
import type { Ui } from '../hooks/pane'
import { bandOf, idleLine } from '../hooks/status'
import { STATES } from './fixtures'
import { PAGE_CSS, Fragment, h, htmlOf, ui } from './html'
import { kitSheet } from './sheet'

// The globals the compiled JSX calls.
;(globalThis as Record<string, unknown>)['h'] = h
;(globalThis as Record<string, unknown>)['Fragment'] = Fragment

const OUT = join(__dirname, '..', '..')
mkdirSync(OUT, { recursive: true })

const BAND_W = 65 * 8 - 40 - 24

for (const [name, make] of Object.entries(STATES)) {
  const d = make()
  const panel = htmlOf(renderPanel(ui as unknown as Ui, d))
  const items = d.backlog?.items ?? []
  const active = items.find(i => i.status === 'planning' || i.status === 'building' || i.status === 'review')
  let below = ''
  if (active) {
    const agent = d.agents.find(a => a.status === 'running')
    const band = bandOf(active, d.ledger, agent, d.now)
    below = `<p class="label caption">Band above the prompt</p><div class="svg" style="width:${BAND_W}px;height:${BAND_H}px">${bandSvg(band, BAND_W)}</div>`
  } else if (name === 'idle') {
    const strip = `pipeline · ${idleLine(items)}`
    below = `<p class="label caption">Idle strip above the prompt</p><div class="svg" style="width:${BAND_W}px;height:${BAND_COMPACT_H}px">${idleStripSvg(strip, BAND_W)}</div>`
  }
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pipeline preview · ${name}</title><style>${PAGE_CSS}</style></head>
<body><p class="label">Panel · ${name}</p><div class="pane">${panel}</div>${below}</body></html>
`
  writeFileSync(join(OUT, `${name}.html`), page)
  console.log(`wrote ${join(OUT, `${name}.html`)}`)
}

// The component sheet: every primitive and every drawing, each tone and state.
writeFileSync(
  join(OUT, 'kit.html'),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pipeline preview · kit</title><style>${PAGE_CSS}</style></head>
<body><p class="label">Kit · every primitive and component</p><div class="pane sheet">${kitSheet(520)}</div></body></html>
`,
)
console.log(`wrote ${join(OUT, 'kit.html')}`)
