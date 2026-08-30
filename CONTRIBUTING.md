# Contributing to Roundtable

Roundtable is developed independently from OpenMausBot. Please open Roundtable issues and pull requests in this repository rather than in the upstream project.

## Before you start

- Search existing issues and pull requests.
- Keep changes focused and explain the user-visible behavior they alter.
- Never commit API keys, tokens, provider credentials, local event logs, or contents of `~/.Roundtable`.
- Preserve the Apache 2.0 license headers and upstream attribution where applicable.

## Development setup

Use Node.js 24 or newer and pnpm 10.

```sh
git clone https://github.com/zhml530/Roundtable.git
cd Roundtable
pnpm install --frozen-lockfile
pnpm dev:desktop
```

`pnpm dev:desktop` builds the orchestration server, starts Vite, and launches Electron. `pnpm dev` starts only the renderer and is useful for UI-only work.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/` | React user interface and client state |
| `server/` | Local orchestration, drivers, sessions, approvals, and persistence |
| `electron/` | Desktop process, preload bridge, packaging, updater, and native helpers |
| `shared/` | Types and contracts shared across processes |
| `apps/docs/` | Maintained user and contributor documentation site |
| `docs/` | Focused setup, architecture, and release notes |
| `scripts/` | Build, packaging, validation, and smoke-test helpers |

## Required checks

Run the checks that cover your change. Before opening a pull request, the expected baseline is:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Packaging changes should also run the relevant platform package or smoke command. Do not weaken a release verification gate without documenting why the replacement provides equivalent coverage.

## Pull requests

Include:

- the problem and intended behavior;
- screenshots or a short recording for visible UI changes;
- the checks you ran;
- migration, compatibility, or security notes when relevant.

New provider adapters should document installation, authentication ownership, model discovery, permissions, cancellation, and the failure state shown when the provider is unavailable.

## Documentation

Document only behavior present in the current tree. Clearly label experimental or platform-specific behavior. Historical design plans are intentionally not kept in the public documentation because they are not a promise of support.
