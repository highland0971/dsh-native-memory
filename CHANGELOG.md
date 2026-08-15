# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-08-15

### Added

- `memory_consolidate` (read-only): deterministic near-duplicate merge
  suggestions (Jaccard over ASCII words + CJK bigrams, capped at 5 pairs)
  plus the remaining fact budget; merges land through the gated edit/forget
  tools.
- `memory_import` (approval-gated): import candidate facts from a past
  session's log by literal query match — exact-cwd authorized, self
  excluded, one approval ask per candidate, stored with the original
  `(sessionId, seq)` provenance.

### Changed

- `memory_recall`: three-tier deterministic scoring — exact tag match >
  case-insensitive text substring > fuzzy tag overlap, CJK bigram
  tokenization, multi-word phrase boost; bilingual query guidance in the
  tool description.
- Caps are pre-checked BEFORE the approval ask, so over-cap writes no longer
  waste a human approval (the domain layer stays the authoritative
  race-proof gate).
- `memory_search` excludes the calling session from its results.

### Fixed

- Profile injection hardening: `<memory-profile>` delimiter tags plus
  `\u003c` escaping of literal `<` in entries and the workspace label
  (session-reference-style).

### Docs

- Headless profiles: documented the opt-in storage-domain mount patch
  (shares the same `~/.dsh/storages` unit with the web profile).

## [0.1.0] — 2026-08-15

### Added

- Per-workspace memory domain over the harness's own storage-domain facility:
  `facts` + `profiles` tables in one unit (`~/.dsh/storages/dsh_memory.json`),
  zod-validated at the durable boundary, with provenance on every fact
  (`sessionId`, `seq`).
- Six model-facing tools: `memory_remember`, `memory_edit`, `memory_forget`
  (writes, approval-gated, fail closed), `memory_recall` (deterministic
  bounded scan), `memory_search` (FTS over past sessions via session-query,
  exact-cwd authorized), `memory_profile` (read the always-injected
  workspace profile).
- Order-88 prompt section injecting the bounded workspace profile, framed as
  untrusted persisted notes; the domain opens lazily on first use.
- Configurable hard caps: 300 facts/workspace, 2000 chars/fact, 8 profile
  entries × 240 chars — enforced with consolidation guidance.
- Bundle patch (`cordis.patch.yml`): enables session-query full-text search
  (`openAt: first-search`, durable index at
  `~/.dsh/storages/session-search.sqlite`) and inserts the host-plane plugin
  row.
- Degradation paths: headless profiles (no storage-domain) keep the plugin
  mounted with tools answering a disabled error; missing approval or
  answerers fail writes closed; search-disabled backends report
  `SESSION_QUERY_SEARCH_DISABLED`.
- 39 unit tests, including domain tests over the real published
  storage-domain facility with an in-memory backend (the harness's own
  pattern), and a full live-verification loop on a real deployment
  (approval audit pairs, recall/forget/profile, FTS index creation,
  cross-session persistence).

## [Unreleased]

(empty — see the v0.2.0 roadmap in docs/design.md §11)
