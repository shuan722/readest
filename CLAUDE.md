# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo overview

This is the `readest/readest` pnpm monorepo (root `package.json` name
`@readest/monorepo`). It contains three independent apps plus shared packages,
several of which are git submodules:

| Path | What it is |
|---|---|
| `apps/readest-app` | **The main product.** A Next.js 16 + Tauri v2 app shipping to web, desktop (macOS/Windows/Linux), and mobile (iOS/Android). Has its own detailed `apps/readest-app/CLAUDE.md` — read that before working inside it. |
| `apps/readest-calibre-plugin` | A Python calibre GUI plugin that pushes books from a user's calibre library into their Readest cloud library. Standalone `Makefile` (`make zip`, `make test`, `make install`), version stamped from `apps/readest-app/package.json` via `sync_version.py`. |
| `apps/readest.koplugin` | A KOReader plugin (Lua) providing sync, LocalSend transfer, and self-update inside KOReader. Tested via `pnpm lint:lua` / `pnpm test:lua` at the repo root (busted specs under `spec/`), plus a standalone Rust crate at `native/localsend-bin`. |
| `packages/foliate-js` | Git submodule — forked Foliate JS engine; the actual EPUB/MOBI/FB2/CBZ/PDF rendering engine `readest-app` builds on. |
| `packages/tauri` | Git submodule — Readest's Tauri fork. |
| `packages/simplecc-wasm` | Git submodule — Traditional/Simplified Chinese conversion (WASM). |
| `packages/qcms` | Git submodule (from `pdf.js.qcms`) — color management for PDF rendering. |
| `packages/js-mdict` | Git submodule — MDict dictionary format reader, reused by `readest-app`'s dictionary plugin tooling. |

Because of the submodules, `git submodule update --init --recursive` is required after clone and after pulling changes that bump a submodule pointer — see `.gitmodules` for the full list (it also includes two `apps/readest-app/src-tauri/plugins/*` submodules and an `apps/readest-app/.claude/skills/gstack` submodule).

## Root-level commands

These proxy into `apps/readest-app` via pnpm workspace filters, or operate across the whole workspace:

```bash
pnpm install                          # install all workspace deps (run after submodule update)
pnpm --filter @readest/readest-app setup-vendors   # copy pdfjs/simplecc/jieba vendor assets — required once before dev/build/lint

pnpm test                             # -> readest-app unit tests (vitest)
pnpm test:lua                         # -> koplugin busted specs
pnpm lint                             # -> readest-app: tsc + biome lint
pnpm lint:lua                         # -> koplugin Lua syntax/lint check
pnpm tauri                            # -> readest-app Tauri CLI
pnpm dev-web                          # -> readest-app web-only dev server

pnpm fmt:check                        # Rust format check (src-tauri)
pnpm clippy:check                     # Rust lint (src-tauri)

pnpm worktree:new <branch|pr-number>  # create a worktree with submodules/deps/env wired up correctly
pnpm worktree:rm

pnpm format                           # biome format --write . (whole repo)
pnpm format:check
```

For anything specific to building, testing, or running `readest-app` itself
(unit/browser/Tauri/E2E/Android test tiers, dev servers per platform, i18n,
design system, e-ink rules, PR review workflow, etc.), see
**`apps/readest-app/CLAUDE.md`** and the docs it links to
(`apps/readest-app/docs/architecture.md`, `code-layout.md`, `testing.md`).
Don't duplicate that content here — start there once you're working inside
that app.

## Working across apps

- `apps/readest-app` is the source of truth for the product version — both
  `apps/readest-calibre-plugin` (via `sync_version.py`) and the release
  pipeline stamp their own version strings from
  `apps/readest-app/package.json` at release time.
- `apps/readest.koplugin` and `apps/readest-calibre-plugin` are otherwise
  independent tooling ecosystems (Lua/busted and Python/unittest
  respectively) — don't assume the TypeScript/Biome/Vitest conventions from
  `readest-app` apply there.
- Prerequisites for building anything Tauri-related (Rust/Cargo, Node/pnpm,
  platform SDKs) are documented in `CONTRIBUTING.md`; a Nix flake
  (`flake.nix`) provides dev shells (`nix develop`, `nix develop .#android`,
  `nix develop .#ios`) that set these up automatically.
