# Ubuntu Desktop

Roundtable has an Ubuntu 24.04 LTS x86_64 desktop beta. The Electron package embeds the harness server, so
installed builds do not require Node, pnpm, Swift, or a terminal at runtime.

## What works

- The native Electron window and embedded Roundtable server on GNOME Xorg and GNOME Wayland.
- Local Claude, Codex, Grok, Gemini, and other configured agent CLIs.
- Chat, streaming turns, approvals, bot-to-bot communication, and local data storage.
- Optional Box cloud computers.
- External documentation and OAuth links in the default browser.
- An explicit, view-only local screen preview on GNOME Xorg and GNOME Wayland. The Wayland path uses the
  native portal chooser and keeps the selected PipeWire stream open until the user stops sharing.

The local preview does **not** give a bot control of this computer. Automatic Wayland helper installation,
Linux dictation and ARM64 remain unavailable.

## Download packages

Choose one Ubuntu 24.04 x86_64 package from the latest release:

- [Debian package (`Roundtable-amd64.deb`)](https://github.com/zhml530/Roundtable/releases/latest/download/Roundtable-amd64.deb) — recommended; APT installs its desktop dependencies.
- [Portable AppImage (`Roundtable.AppImage`)](https://github.com/zhml530/Roundtable/releases/latest/download/Roundtable.AppImage) — does not install system files.
- [SHA-256 checksums](https://github.com/zhml530/Roundtable/releases/latest/download/SHA256SUMS-ubuntu-x64.txt)

Versioned packages and previous releases remain available on the
[releases page](https://github.com/zhml530/Roundtable/releases).

## Build packages

Requirements for building from source:

- Ubuntu 24.04 LTS x86_64
- Node.js 24 or newer
- pnpm 10.33.0 (Corepack can install the version declared by the project)

```sh
git clone https://github.com/zhml530/Roundtable.git
cd Roundtable
corepack enable
pnpm install --frozen-lockfile
pnpm package:linux
```

The build creates:

- `release/Roundtable-<version>-amd64.deb`
- `release/Roundtable-<version>-x86_64.AppImage`

The AppImage uses a static runtime and does not require the legacy `libfuse2` package.

## Install and run

Install a downloaded Debian package with APT so its desktop dependencies are resolved:

```sh
sudo apt install ./Roundtable-amd64.deb
```

Then open **Roundtable** from the GNOME application launcher. To remove it:

```sh
sudo apt remove Roundtable
```

The portable AppImage does not install system files:

```sh
chmod +x release/Roundtable-*-x86_64.AppImage
./release/Roundtable-*-x86_64.AppImage
```

For a downloaded release AppImage, use `Roundtable.AppImage` in place of the versioned path above.

Application data remains local in `~/.Roundtable`. Electron browser data and window state use the normal XDG
configuration directory (`~/.config/Roundtable` unless the environment overrides it).

## Develop the desktop shell

The desktop development command builds the orchestration server, starts Vite, and launches Electron:

```sh
pnpm dev:desktop
```

For a package-shaped build without creating `.deb` or AppImage artifacts:

```sh
pnpm package:linux:dir
./release/linux-unpacked/Roundtable
```

## Agent CLI discovery

Applications launched from GNOME do not inherit the same interactive shell `PATH` as a terminal. Roundtable
keeps the inherited path and adds existing common locations such as:

- `~/.local/bin`
- `~/.claude/local`
- `~/.volta/bin`
- `~/.bun/bin`
- `~/.asdf/shims`
- `~/.deno/bin`
- `~/.nvm/versions/node/*/bin`
- `/usr/local/bin`

It also probes the login shell in the background. If a CLI still is not detected, set an explicit additional
path before launching the app from a terminal and verify it there:

```sh
OMB_EXTRA_PATH=/your/custom/bin ./release/Roundtable-*-x86_64.AppImage
```

Restart Roundtable after installing or signing in to a CLI.

## Xorg and Wayland

The shell, chat, cloud computers, and preview-only capture work in both GNOME session types.
The Wayland chooser/select/persistent-stream/cancel/end/retry lifecycle has been validated in a real Ubuntu
24.04 GNOME Wayland session. Roundtable detects Wayland before XWayland when both `WAYLAND_DISPLAY` and
`DISPLAY` exist, so capture cannot accidentally bypass portal-mediated behavior.

## Validate a package change

```sh
pnpm typecheck
pnpm test
pnpm check:electron
pnpm package:linux
node scripts/verify-linux-package.mjs
pnpm smoke:linux-package
```

The verifier checks package metadata and desktop identity. The local smoke launches the unpacked app and AppImage
without `--no-sandbox`; CI also checks an in-place Debian package upgrade before running the installed app.

## Troubleshooting

### An agent CLI is missing

Run the CLI directly in a terminal, finish its sign-in flow, then restart Roundtable. If it lives outside the
common directories above, use `OMB_EXTRA_PATH` while testing and report the install location so it can be
considered for automatic discovery.

### A bot needs computer tools

Add a Box API key in App Settings.

### The AppImage does not start

Confirm the executable bit and architecture:

```sh
chmod +x Roundtable-*-x86_64.AppImage
file Roundtable-*-x86_64.AppImage
```

Run it from a terminal once to collect the startup output. Do not install `libfuse2` just for this AppImage; the
package is built with the static runtime.

