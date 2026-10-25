---
type: tool_order
before: { tool: Read, input_match: 'notes-cli[\\/]+src[\\/]+' }
after: { tool: Write, input_match: '\.shipright[\\/]+plans[\\/]+' }
---
The project's source was read before the plan was written. (On a project this small the skill reads the files directly; on a larger one Explore agents name them first and the session then reads them, so this holds either way.)
