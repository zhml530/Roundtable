# Roundtable

Roundtable is a local-first desktop app for organizing and running a team of AI bots. Each bot can use its own provider, model, instructions, working directory, and avatar; bots can also collaborate in shared channels.

## Current capabilities

- Create reusable bot profiles with custom avatars, models, instructions, and working folders.
- Chat with one bot or bring several bots into a channel with shared context.
- Review tool and permission requests before an agent performs sensitive work.
- Inspect activity, token usage, tasks, routines, and Team Map relationships.
- Attach files and images to conversations and search local message history.
- Import and export team definitions for repeatable setups.
- Run through built-in adapters for Claude, Codex, GitHub Copilot CLI, Cursor Agent, OpenCode, Gemini, Grok, Kimi, Qwen, Hermes, Droid, Pi, MiniMax, Antigravity, Box Agent, and OpenAI-compatible endpoints. Availability depends on the corresponding CLI, account, and credentials installed on your computer.
- Package the desktop app for macOS, Windows, and Ubuntu.

Connected Apps and USB Android control are not part of the current supported product surface.

## Architecture

```mermaid
flowchart LR
    U[User] --> D[Roundtable desktop]
    D --> R[Local orchestration runtime]
    R --> B[Bot profiles and channels]
    R --> P[Provider and ACP drivers]
    R --> S[(Local Roundtable data)]
    P --> C[Installed CLIs and model services]
```

The Electron renderer talks to a desktop-owned local orchestration process. Provider CLIs run with the current user's permissions, while approval prompts remain the consent boundary for sensitive actions. Application data is stored locally under `~/.Roundtable`.

## Run from source

Requirements:

- Node.js 24 or newer
- pnpm 10.33.0 or a compatible pnpm 10 release
- At least one supported provider CLI or API configuration

```sh
git clone https://github.com/zhml530/Roundtable.git
cd Roundtable
pnpm install --frozen-lockfile
pnpm dev:desktop
```

Use `pnpm dev` when you only need the browser renderer. The complete desktop development path is `pnpm dev:desktop`.

## Default bots and role prompts

An empty fleet starts with three bots: **Reviewer** for evidence-based review,
**Planner** for read-only task planning, and **Executor** for implementation and
validation. Each inherits the application's default provider and model. Existing
fleets are not changed, and removed starter bots are not recreated while other
bots remain.

The **Getting Started** channel includes all three starter bots, a shared
bulletin explaining their roles, and a welcome message with example requests.
Mention an individual bot or use `@everyone` to involve the whole team. The
channel is ready to open without additional setup; choose a working folder
before requesting file changes. Creating the channel does not run any bots.
Existing channels are untouched, and deleting the starter channel does not
cause it to reappear on restart.

Edit each bot's instructions under **Agent profile > Description**. The runtime
includes **Title** as its role and **Description** as persona instructions in
direct chats and channel tasks; these fields are saved in `~/.Roundtable/bots.json`
(or the configured `OMB_DATA_DIR`). The initial templates live in
`server/default-bots.ts`. Role instructions guide behavior, not enforce tool
permissions; normal approval controls still apply. The Planner bot does not
replace the system Coordinator.

## Validate a change

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Provider-specific setup:

- [Cursor Agent CLI](docs/cursor.md)
- [OpenCode](docs/opencode-go.md)
- [Ubuntu desktop](docs/linux-desktop.md)

Project documentation is also available under [`apps/docs`](apps/docs).

## Downloads and releases

The new repository does not claim continuity with binaries published by the former repository. New Roundtable releases will appear on the [GitHub Releases page](https://github.com/zhml530/Roundtable/releases) after its release workflow and signing configuration have been set up and verified.

Maintainers should read [the release guide](docs/releasing.md) before publishing artifacts.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report security issues using the process in [SECURITY.md](SECURITY.md), not a public issue.

## License and upstream attribution

Roundtable is distributed under the [Apache License 2.0](LICENSE). Portions are derived from OpenMausBot; the required attribution and the independent-project notice are recorded in [NOTICE](NOTICE).
