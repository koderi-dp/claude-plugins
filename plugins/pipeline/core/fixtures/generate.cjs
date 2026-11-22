// Regenerates index.ts from the Markdown fixtures in this folder: node generate.cjs
const fs = require('node:fs')
const path = require('node:path')
const esc = s => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
const files = [['CATALO_BACKLOG', 'catalo-backlog.md'], ['CATALO_QUEUE_2026_11', 'catalo-queue-2026-11.md'], ['OPENHUDDLE_CLAUDE', 'openhuddle-claude.md'], ['OPENHUDDLE_WORKFLOW', 'openhuddle-workflow.md']]
let out = '// Generated from the Markdown fixtures in this folder, which are trimmed copies of two real projects.\n// Tests can only import TypeScript, so the texts live here too; regenerate after editing a .md file:\n//   cd plugins/pipeline/hooks/fixtures && node generate.cjs\n\n'
for (const [name, file] of files) out += `/** ${file} */\nexport const ${name} = \`${esc(fs.readFileSync(path.join(__dirname, file), 'utf8'))}\`\n\n`
fs.writeFileSync(path.join(__dirname, 'index.ts'), out.trimEnd() + '\n')
