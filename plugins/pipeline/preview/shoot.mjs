// Screenshots of every out/*.html, in both colour schemes: out/<state>.png (dark) and out/<state>-light.png, at
// device scale 2, full height.
// Run after render: node plugins/pipeline/preview/shoot.mjs
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const out = join(dirname(fileURLToPath(import.meta.url)), 'out')
const browser = await chromium.launch()
const files = readdirSync(out).filter(f => f.endsWith('.html')).sort()
// Every page twice: dark as `<state>.png`, light as `<state>-light.png`.
for (const [colorScheme, suffix] of [['dark', ''], ['light', '-light']]) {
  const context = await browser.newContext({ colorScheme, deviceScaleFactor: 2, viewport: { width: 600, height: 800 } })
  const page = await context.newPage()
  for (const file of files) {
    await page.goto(pathToFileURL(join(out, file)).href)
    await page.waitForTimeout(100)
    const png = join(out, file.replace(/\.html$/, `${suffix}.png`))
    await page.screenshot({ path: png, fullPage: true })
    console.log(`shot ${png}`)
  }
  await context.close()
}
await browser.close()
