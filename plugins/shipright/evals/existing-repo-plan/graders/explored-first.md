---
type: tool_order
before: { tool: Agent, input_match: '"subagent_type"\s*:\s*"Explore"' }
after: { tool: Write, input_match: '\.shipright[\\/]+plans[\\/]+' }
---
An Explore agent ran before the plan was written.
