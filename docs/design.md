# dsh-native-memory — Design

Status: **approved for implementation** (prepared 2026-08-15, verified against
deepseek-harness 0.1.0-rc.5 @ commit 47f9438).

## 1. Problem statement

DeepSeek Harness persists every session's event log and offers manual
cross-session references, but it has **no automatic long-term memory**: a new
session starts from an empty log. The community answer so far
(`dsh-hermes-memory`) works but was evaluated in this environment and found
wanting on four counts:

| Weakness of dsh-hermes-memory | How this design answers it |
|---|---|
| User-global memory, no project scoping; cross-project contamination | Per-workspace memory domains, exact-cwd authorization |
| Model writes are injected verbatim into future prompts — a standing prompt-injection vector | Every write passes the host approval stack; injected text is framed as untrusted data |
| Hard total caps, everything always injected, no retrieval | Bounded always-on profile + on-demand deterministic recall + FTS over past sessions |
| Persists into `settings.yaml`; skills inflate one YAML file | Dedicated storage-domain unit (`~/.dsh/storages/dsh_memory.json`), no settings coupling |

The name states the strategy: **native** — every capability rides a seam the
harness already ships (storage-domain, session-query, approval, tools,
systemPrompt). No external server, no extra runtime dependency, no vendored
imports, no custom SQLite.

## 2. Planes

Memory crosses sessions, so by the harness's own plane rule
("anything crossing sessions stays host-side") the plugin row lives in the
**HOST composition**, contributed by the bundle patch — exactly like
`session-persistence-jsonl` and `tool-todo` in dsh-base. The plugin publishes
**no service**, only consumes host registries, so no isolate realm is needed.
No agent preset is shipped: tools are available to every session, and the
prompt profile is toggled by config (`injectProfile`), which a user's own
`cordis.patch.yml` can override per deployment.

## 3. Data model (storage-domain)

One domain, JSON backend (web profile default), unit file
`~/.dsh/storages/dsh_memory.json`:

- `global`: `{ initialized: true }` — creation marker.
- table `facts` — key `id` (uuid). Value: `{ id, workspacePath, kind, text,
  tags[], sessionId, seq, createdAt, updatedAt, state }`. `kind ∈
  {preference, fact, convention, decision}`.
- table `profiles` — key `workspacePath`. Value: `{ workspacePath, entries[],
  updatedAt }` — the always-injected, bounded workspace profile.

Zod v4 schemas (matching DSH's own storage-domain dependency). Validation at
the durable boundary is the facility's job; writes await backend durability
before mutating memory.

**Provenance**: every fact carries `(sessionId, seq)` — cited memory,
reconstructable from the lossless session log. This is the audit trail
behind the approval gate: ask/outcome pairs land on the requesting session's
log, and each fact names the session and log position that justified it.

**Caps** (config): facts ≤ 300/workspace, fact ≤ 2000 chars, profile ≤ 8
entries × 240 chars. Recall over the facts table is a bounded in-memory scan
(the JSON backend has no FTS) — deterministic, zero-token-waste, and the cap
keeps it cheap.

## 4. Recall paths

1. **Always-on profile** — `systemPrompt` section, order 88, provider form.
   Renders only the caller session's workspace profile, framed as untrusted
   persisted notes. ~600 tokens worst case, typically far less.
2. **`memory_recall`** — read-only scan over active facts of the caller's
   workspace (text first, tags second, recency tiebreak).
3. **`memory_search`** — FTS over past sessions via
   `ctx.sessionQuery.searchEvents`, exact-cwd authorized (same rule as
   dsh-tool-session-query). Requires the bundle's FTS patch (below).
4. **`memory_profile`** — read the workspace profile; propose changes, then
   land them through `memory_remember` (gated).

## 5. Tools

`memory_remember` / `memory_edit` / `memory_forget` — writes, approval-gated
when `approvalWrites: true` (default). `memory_recall` / `memory_search` /
`memory_profile` — reads, never gated.

Tool count trades prompt cost against capability; keep the set closed until
usage data says otherwise.

## 6. Bundle patch (cordis.patch.yml)

Two entries (a patch replaces whole configs; the user's layer wins):

- `session-query-sqlite` → `{ path: dshHomePath('storages/session-search.sqlite'),
  openAt: first-search }` — enables FTS (shipped default: `openAt: never`,
  `:memory:`).
- `insert` → the `dsh-native-memory` plugin row with the config block.

`dshHomePath` and `!!js` are available to bundle patches (dsh-base uses both).

## 7. Failure & degradation

- `storageDomain` absent (headless profile) → plugin stays mounted, memory
  tools answer a disabled error; prompt section omitted. No hang, no crash.
- `sessionQuery` absent or search disabled → `memory_search` reports
  `SESSION_QUERY_SEARCH_DISABLED`; recall/profile keep working.
- `approval` absent or answerers unavailable → writes fail closed.
- Domain version mismatch → loud error at open; memory offline until migrated.

## 8. Security model

- Writes: human-approved, session-log audited.
- Reads: exact-cwd workspace authorization — a session can only touch facts
  and profiles for its own workspace path.
- Injection: bounded, framed as data, order 88; hardening backlog below.
- The bundle runs third-party code with the user's own permissions — README
  must carry the same warning the awesome list requires.

## 9. Verified compatibility facts (0.1.0-rc.5 @ 47f9438)

- `ctx.tools.register` ToolDefinition: name/description/parameters,
  `output: {schema, render}`, `execute(args, exec)` —
  packages/core/tools/src/index.ts:222.
- `ctx.systemPrompt.section({name, order, text})`, text accepts a provider —
  packages/core/system-prompt/src/index.ts:53.
- `ctx.storageDomain.open({name, version, tables})`,
  `domainTable(schema)` zod v4 — packages/storage/storage-domain.
- `ctx.approval.request({agent, toolName, callId?, reason?})` —
  packages/interaction/user-approval/src/index.ts:153.
- `ctx.sessionQuery.searchEvents` + `SESSION_QUERY_SEARCH_DISABLED` —
  packages/session-query; sqlite config `openAt: startup|first-search|never`.
- Bundle mechanism: `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`,
  installed via `dsh plugin add` (npm / git / path / tarball), joined to
  `dsh.profile.bundles` — apps/cli/src/plugin.ts.
- External PRs into deepseek-harness are NOT accepted (CONTRIBUTING.md);
  ecosystem route: standalone repo + `dsh-plugin` topic + awesome-dsh-plugin.

## 10. Competitive landscape (awesome-dsh-plugin "Memory" section)

Distinctive claim among ~20 memory plugins: **the only zero-dependency,
per-workspace, approval-gated, cited memory built entirely on the harness's
own persistence seams** — no external server (vs dsh-mnemon, sgme, memoria),
no custom SQLite of its own (vs dsh-memento, dsh-mneme), not user-global
(vs dsh-hermes-memory, dsh-memory-vault), no settings.yaml bloat.

## 11. Roadmap

- **v0.1.0** (this repo): domain + tools + approval gate + profile section +
  bundle patch + tests + docs. Local verification on this environment first
  (see docs/handoff.md), then community release.
- v0.2.0: `<memory-profile>` framing hardening (delimiter tags, `\u003c`
  escaping, mirror session-reference), profile auto-consolidation tool,
  `memory_import` from session logs.
- v0.3.0: relevance-scored recall (RRF over tags + text), fact dedup/conflict
  detection, headless profile support path (opt-in memory unit via
  storage-json mount in headless).

## 12. Contribution path (target: DeepSeek community)

1. Publish `dsh-native-memory` to npm.
2. GitHub repo + `dsh-plugin` topic.
3. PR to awesome-dsh-plugin (one line each in README.md + README.zh.md).
4. Optional: dsh-market listing, discussion #525-style announcement in
   deepseek-harness Discussions.
