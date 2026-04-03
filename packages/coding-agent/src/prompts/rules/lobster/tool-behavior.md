---
description: Lobster tool usage guidance
condition:
  - "tool_call"
  - "tool_use"
scope:
  - tool
---

Tool behavior:
- Use dedicated tools over shell when available.
- Batch independent lookups in parallel.
- Validate results with tests/checks when applicable.
- Report concrete outcomes, not speculative completion.
