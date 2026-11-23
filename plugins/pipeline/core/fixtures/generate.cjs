// Regenerates index.ts from the Markdown fixtures in this folder: node generate.cjs
const fs = require('node:fs')
const path = require('node:path')
const esc = s => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
const files = [['STATUS_TABLE_BACKLOG', 'status-table-backlog.md'], ['STATE_TABLE_QUEUE', 'state-table-queue.md'], ['WAVE_QUEUE_CLAUDE', 'wave-queue-claude.md'], ['WORKFLOW_PROSE', 'workflow-prose.md']]
let out = '// Generated from the Markdown fixtures in this folder: invented texts in the shapes a project keeps its queue and its process in.\n// Tests can only import TypeScript, so the texts live here too; regenerate after editing a .md file:\n//   cd plugins/pipeline/core/fixtures && node generate.cjs\n\n'
for (const [name, file] of files) out += `/** ${file} */\nexport const ${name} = \`${esc(fs.readFileSync(path.join(__dirname, file), 'utf8'))}\`\n\n`
fs.writeFileSync(path.join(__dirname, 'index.ts'), out.trimEnd() + '\n')
