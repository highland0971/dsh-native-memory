# Security

> Installing this plugin runs code with your own permissions — it can read
> your files, use your credentials, and reach the network. Tool approvals do
> not sandbox plugin code. Review the source before you install.

## Threat model

The memory store is durable, shared across sessions of a workspace, and part
of it is injected into future prompts. Two adversaries matter:

1. **An untrusted input processed by the agent** (malicious repo content, web
   pages, referenced sessions) persuading the model to write prompt content.
2. **A confused model** quietly accumulating wrong or conflicting facts that
   later steer every session.

## Controls

- **Write approval gate** (default on). Every `memory_remember`,
  `memory_edit`, `memory_forget` passes `ctx.approval.request`; the human
  sees the text that would be persisted and can reject it. Every ask/outcome
  pair is logged to the requesting session — the decision is reconstructable.
- **Workspace authorization**. Reads and writes are exact-cwd scoped: a
  session can only touch facts and profiles for its own workspace path.
  Cross-workspace access is impossible by construction (the domain records
  carry the workspace path and the service refuses mismatches).
- **Bounded injection**. The always-on profile is capped (default 8 entries ×
  240 chars) and framed in the prompt as untrusted persisted notes to treat
  as data, not instructions.
- **Provenance**. Every fact records `(sessionId, seq)`; a fact can be traced
  to the session and log position that produced it.
- **Fail closed**. Missing approval service/answerers, a mismatched domain
  version, or disabled search all produce loud errors, never silent writes.

## Known limitations (v0.1.0)

- The injected profile is not yet delimiter-framed or `\u003c`-escaped (the
  hardening the session-reference subsystem uses) — on the v0.2.0 backlog.
- Facts are plaintext in `~/.dsh/storages/dsh_memory.json` (same as the rest
  of DSH's local storage). Do not ask the model to store secrets; store
  references and use the credentials service instead.
- Read tools are not approval-gated: any session can recall its workspace's
  facts and search its workspace's past sessions. This matches the harness's
  own session-query authorization model.
- `approvalWrites: false` removes the human gate — only disable it on
  single-user machines you fully trust.
