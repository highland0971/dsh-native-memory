# dsh-native-memory

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Native, per-workspace long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): facts and profiles stored on the harness's **own** storage-domain, cross-session recall through **session-query FTS**, **approval-gated** writes, and cited provenance — no external server, no extra runtime dependency.

> ⚠️ Installing a plugin runs third-party code on your machine with your own
> permissions. Review the source ([`src/`](src)) and [the security model](docs/security.md)
> before installing.

## Why this one

| | dsh-hermes-memory | dsh-native-memory |
|---|---|---|
| Storage | `~/.dsh/settings.yaml` namespace | dedicated storage-domain unit (`~/.dsh/storages/dsh_memory.json`) |
| Scope | user-global, all projects | **per workspace** (exact-cwd authorization) |
| Write safety | silent, model-only | **human approval gate** + session-log audit |
| Recall | everything always injected (hard caps) | bounded always-on profile **plus** on-demand recall + FTS over past sessions |
| Dependencies | vendored imports into the harness checkout | none beyond zod + the harness itself |

See [docs/design.md](docs/design.md) for the full architecture and the
competitive landscape analysis.

## Install

```sh
dsh plugin --profile web add dsh-native-memory   # npm after release
dsh plugin --profile web add /path/to/this/repo  # from a checkout
```

Restart `dsh web`. The bundle enables session-query full-text search and adds
the memory tools to every session. Details and configuration:
[docs/install.md](docs/install.md).

## Tools

| Tool | Kind | Gate |
|---|---|---|
| `memory_remember` | add/update a fact in this workspace | approval |
| `memory_edit` | replace a fact | approval |
| `memory_forget` | archive a fact (soft delete) | approval |
| `memory_recall` | deterministic three-tier keyword scan (tags > text > fuzzy) | none |
| `memory_search` | FTS over this workspace's past sessions (caller excluded) | none |
| `memory_consolidate` | near-duplicate merge suggestions + cap budget | none |
| `memory_import` | import candidate facts from a past session's log | approval (per fact) |
| `memory_profile` | read the always-injected workspace profile | none |

Every fact records its origin `(sessionId, seq)` — memory stays
reconstructable from the lossless session log.

## Development

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm test
```

New contributors start at [docs/handoff.md](docs/handoff.md) and
[docs/contributing.md](docs/contributing.md). Chinese docs:
[README.zh.md](README.zh.md).

## License

[MIT](LICENSE)
