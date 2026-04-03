Your previous attempt at the task below was completed but failed automated verification checks.

You **MUST** fix the issues reported below and call `submit_result` once your work passes.

{{SECTION_SEPERATOR "Original Task"}}
{{task}}

{{SECTION_SEPERATOR "Verification Failures"}}
{{failureSummary}}

{{#each failedCommands}}
**`{{this.name}}`** (`{{this.command}}`):
```
{{this.output}}
```
{{/each}}

{{SECTION_SEPERATOR "Instructions"}}
- Address every failure above before calling `submit_result`.
- Do **not** modify test infrastructure or suppress checks to make them pass.
- If a check is genuinely inapplicable to your changes, explain why in `result.notes` and call `submit_result` with `result.error` set to that explanation.
- You **MUST NOT** give up or skip fixes that are within your ability to make.
