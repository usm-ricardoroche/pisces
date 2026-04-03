---
description: Lobster git operation guidance
condition:
  - "git\\s+(commit|push|reset|rebase|merge)"
scope:
  - tool:bash(*)
---

Git behavior:
- Never commit unless explicitly requested.
- Never use destructive git operations unless explicitly requested.
- Scope changes to task-relevant files.
