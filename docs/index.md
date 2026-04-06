---
layout: home

hero:
  name: pisces
  text: A coding agent built for embedding
  tagline: RPC-first · session trees · zero-cost rules · Rust-native core
  image:
    src: /hero-dark.png
    alt: pisces terminal screenshot
  actions:
    - theme: brand
      text: Feature Reference
      link: /features
    - theme: alt
      text: SDK
      link: /sdk
    - theme: alt
      text: GitHub
      link: https://github.com/usm-ricardoroche/pisces

features:
  - title: RPC mode & SDK
    icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M7 8l3 3-3 3M13 14h4"/></svg>'
    details: Run as a headless subprocess over newline-delimited JSON-RPC on stdio, or embed directly via the TypeScript SDK. Both surfaces expose identical session control, event streaming, and tool wiring — no TUI required.
    link: /rpc
    linkText: RPC reference

  - title: Session tree with branching
    icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M6 12h10"/></svg>'
    details: Every message is a node in an append-only tree. Branch at any point, navigate back through history, hand off to a new session with generated context — without rewriting or losing prior work. Compaction summarises only what you choose.
    link: /session
    linkText: Session model

  - title: Time-Traveling Stream Rules (TTSR)
    icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/><path d="M18 2v4h4"/></svg>'
    details: Rules inject themselves mid-stream the moment the model's output matches a trigger pattern, then the interrupted generation retries with the rule already in context. Zero upfront token cost — rules consume no context until they fire.
    link: /ttsr-injection-lifecycle
    linkText: TTSR lifecycle

  - title: Parallel subagents with isolation
    icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4M6.5 10v4M17.5 10v4M10 17.5h4"/></svg>'
    details: Dispatch typed task batches to named agents running in parallel. Pass isolated=true to run each agent in a git worktree; results come back as diff patches. Spawn depth is enforced — agents cannot recurse beyond the configured limit.
    link: /task-agent-discovery
    linkText: Task agents

  - title: Rust-native core
    icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
    details: Grep, glob, fuzzy-find, PTY, syntax highlighting, ANSI-aware text operations, and clipboard all run through a Rust N-API module with a shared FS scan cache. No spawning external processes for search primitives.
    link: /natives-architecture
    linkText: Natives architecture

  - title: Persistent IPython kernel
    icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M8 21H5a2 2 0 0 0-2-2v-3M21 16v3a2 2 0 0 0-2 2h-3"/><path d="m9 9 2 2 4-4"/></svg>'
    details: Python cells run in a Jupyter kernel gateway — the kernel persists across calls so variables, imports, and state survive between turns. Rich output (dataframes, plots, Mermaid diagrams) renders inline.
    link: /python-repl
    linkText: Python runtime

  - title: Structured blob & artifact storage
    icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>'
    details: Large outputs, images, and subagent results live outside the session JSONL in content-addressed blobs (global, deduplicated by SHA-256) or session-scoped artifact files. Context stays lean; full output is always retrievable via artifact:// URIs.
    link: /blob-artifact-architecture
    linkText: Storage architecture

  - title: Deep extension & plugin model
    icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>'
    details: Register LLM-callable tools, slash commands, keyboard shortcuts, event interceptors, and custom renderers from a single TypeScript factory. Install plugins from any Git-hosted catalog compatible with the Claude plugin registry format.
    link: /extensions
    linkText: Extensions guide
  - title: Shoal multi-agent orchestration
    icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v4M12 11l-5 6M12 11l5 6"/><path d="M5 17V13M19 17V13"/></svg>'
    details: "/team run dispatches agents into isolated Shoal sessions with wave sequencing, action gating, and correlation tracking. Each agent gets its own tmux pane and optional git worktree — fully independent of the parent session."
    link: /features#shoal-team-orchestration
    linkText: Shoal orchestration

  - title: Lobster-party integration
    icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 10h16M4 14h10M4 18h8"/><circle cx="19" cy="17" r="3"/><path d="M19 15v2l1 1"/></svg>'
    details: "PISCES_LOBSTER_MODE=1 loads the messageUser and memorySearch extension tools for lobster-party pipeline deployments. PISCES_MCP_SOCKETS injects shared Unix socket MCP servers from a Shoal-managed pool."
    link: /features#lobster-party-integration-mode
    linkText: Lobster integration

  - title: Budget + telemetry
    icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 4-8"/><circle cx="7" cy="16" r="1.5" fill="currentColor" stroke="none"/><circle cx="11" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="16" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="8" r="1.5" fill="currentColor" stroke="none"/></svg>'
    details: "RunBudgetPolicy enforces 7 budget dimensions per run (tokens, cost, wall time, tool calls, subagents). OtelTelemetryAdapter emits OTLP spans covering the full session/turn/tool hierarchy. Both are zero-overhead when unconfigured."
    link: /features#budget-policy-enforcement
    linkText: Budget & telemetry
---