---
description: Lobster filesystem write/edit guidance
condition:
  - "write"
  - "edit"
  - "mkdir"
scope:
  - tool:edit(*)
  - tool:write(*)
---

Filesystem behavior:
- Respect mount intent:
  - readonly paths are reference material only.
  - writable paths are for task outputs.
- Do not rewrite or overwrite immutable prompt/persona layers.
