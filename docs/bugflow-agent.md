# BugFlow Agent on Windows

BugFlow is an independent, governed Windows agent. Roundtable runs its disposable
`acp` bridge; the current-user named-pipe host is started and managed separately.
Closing a chat or replacing the bridge does not stop that host.

## Install from Engine Settings

Choose **BugFlow Agent > Install fresh EXE** in Engine Settings. On subsequent
installations, choose **Rebuild & reinstall**. This is a local source build, not
a download of a previously built executable and not a Python console launcher.

Build-time prerequisites:

- Windows x64, Git, and Python **3.12 x64** with the `py` launcher.
- Existing noninteractive Git access to the authorized source repository.
- Network access to the Python package index and the SDK runtime download.
- Sufficient free disk space for a fresh source checkout, virtual environment,
  native runtime, and PyInstaller build. The build takes several minutes.

Roundtable does not install global build tools, request administrator access, or
start browser/device login. Missing tools or authorization produce an error;
complete required setup yourself, then retry.
Use a short data-directory path: deeply nested custom directories can exceed
Windows path limits in the package's build or executable smoke tests.

The canonical source is
`https://skype.visualstudio.com/DefaultCollection/SCC/_git/media_intelligence_service`.
The explicit published ref is **`refs/heads/canranjin/bug_flow_dev`**, where source
PR 1552317 was merged. Repository `main` does not contain this package. Each click
fetches that ref once, resolves an exact commit, and builds its detached snapshot.
There is no fallback to another ref, cached checkout, or old `dist` artifact.

Each attempt:

1. Fetches a new sparse BugFlow checkout.
2. Creates an isolated Python build environment and installs the package's
   pinned build/test dependencies.
3. Downloads the package's pinned SDK runtime with its checksum-verifying
   downloader into an isolated build cache.
4. Runs `build.ps1 -ExpectedCommit <commit> -SourceRef <ref> -RequireCleanSource`.
5. Checks clean-source provenance, executable name/size, SHA256 and sidecar,
   and runs the package tests with the actual freshly built EXE.
6. Copies the verified EXE and provenance into a new versioned directory,
   checks its version, and saves that **BugFlow.exe** as the engine's CLI path.

The default managed location is
`%USERPROFILE%\.Roundtable\managed\bugflow\versions\<commit>-<attempt>\BugFlow.exe`.
A custom Roundtable data directory also relocates this managed directory.
Progress is bounded and shown in Settings; only one install runs at a time.
Normal application exit cancels the owned build process and waits for cleanup.
After a crash or forced termination, a leftover `install.lock` is reported
explicitly rather than stolen from a possibly active build.
Failed source access, builds, tests, or provenance checks leave the previous
installation and CLI setting unchanged. Existing EXEs are never overwritten,
including an EXE backing a running host. Unused older versions are retained.
If the selected engine's settings change during a build, they are not
overwritten. Finish its active Roundtable conversations before installing;
other engines are not restarted when the new path is saved.

Successful installation is **not** proof of authentication or host readiness.
The self-contained EXE includes Python and the SDK runtime, but ADO tools still
require an installed Azure CLI and existing current-user authorization.
Organizational application-control policies still apply to the unsigned build.

## Start and authenticate separately

Use the installed executable path shown in Engine Settings:

```powershell
& '<installed path>\BugFlow.exe' --version
& '<installed path>\BugFlow.exe' status --json
# Only when no current-user BugFlow host is already running:
& '<installed path>\BugFlow.exe' serve
```

Installing does not stop, restart, or upgrade an already running host. Arrange
any host replacement explicitly after its active work is finished.

Roundtable's menu probes run only `<selected CLI> status --json`. The command
must return one JSON object containing `state`, `message`, and `version`.
`ready`, `auth_required`, and `unavailable` are determined states with exit zero;
nonzero exits or malformed responses fail closed. An absent host is unavailable,
not a signal to start one. Required login/MFA remains a user action.

## Conversation and permission boundaries

- The provider is `bugflowAgent`, separate from Copilot CLI.
- The sole picker model is `bugflow-default`; BugFlow owns model selection.
  Arbitrary cloud model IDs and `host::model` injection are rejected.
- No external MCP integrations, local file attachments, or images are forwarded.
- Every action requiring permission needs an explicit one-time answer. Full-auto,
  bot auto-approval, and remembered grants cannot bypass it.
- Session resume requires advertised `session/load` support. Failure or a
  mismatched session ID is an error, never a silent new session.
- Historical replay is not displayed as new output or executed as fresh tools.
- Cancellation targets the foreground request through `session/cancel`; bridge
  disposal does not terminate the independent persistent host.
