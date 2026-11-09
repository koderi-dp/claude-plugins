// Screenshots of every out/*.html as out/<state>.png: a dark page at device scale 2, full height.
// Run after render: node plugins/pipeline/preview/shoot.mjs
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const out = join(dirname(fileURLToPath(import.meta.url)), 'out')
const browser = await chromium.launch()
const context = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: 2, viewport: { width: 600, height: 800 } })
const page = await context.newPage()
for (const file of readdirSync(out).filter(f => f.endsWith('.html')).sort()) {
  await page.goto(pathToFileURL(join(out, file)).href)
  await page.waitForTimeout(100)
  const png = join(out, file.replace(/\.html$/, '.png'))
  await page.screenshot({ path: png, fullPage: true })
  console.log(`shot ${png}`)
}
await browser.close()
