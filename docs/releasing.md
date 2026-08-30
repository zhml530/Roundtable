# Releasing Roundtable

Roundtable publishes source and desktop artifacts from the same GitHub repository. The unified workflow is **Actions → Release → Run workflow**.

It pins one commit, builds macOS arm64 and x64, Windows x64, and Ubuntu 24.04 x64, verifies the generated update feeds, and creates or updates a draft release in `zhml530/Roundtable`. Leave **publish** disabled for review; enable it only when the complete asset set and notes are ready.

## Before the first release in the new repository

1. Enable GitHub Actions with read/write workflow permissions.
2. Enable GitHub private vulnerability reporting.
3. Configure the Apple signing and notarization secrets listed below, or adjust the workflow before attempting a macOS release.
4. Confirm that `electron-builder.yml` points to `zhml530/Roundtable`.
5. Run a draft release and install every artifact on its target operating system.
6. Confirm that update metadata points to the new repository before publishing.

Do not copy or relabel binaries from the former repository as new Roundtable releases.

## Per-release checklist

1. Update `package.json` to a version that has not already been published.
2. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`.
3. Run the Release workflow with **publish** disabled.
4. Review signatures, checksums, filenames, update feeds, and release notes.
5. Smoke-test the macOS, Windows, and Ubuntu packages.
6. Publish the draft only when the full release is ready.

The workflow intentionally refuses to overwrite an already-published version.

## Repository secrets

The macOS job currently expects:

- `MAC_CERT_P12_BASE64`
- `MAC_CERT_PASSWORD`
- `APPLE_API_KEY_P8_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER_ID`

These secrets belong to the Roundtable release owner and must be configured afresh. Do not reuse another project's credentials without the credential owner's authorization. Release creation in the same repository uses GitHub's workflow token and does not require a cross-repository personal access token.

## Why the verification gates remain

The workflow cleans generated output, verifies packaged server and UI entry points, checks macOS signatures before notarization, staples artifacts before regenerating hashes, verifies updater feeds against final bytes, and assembles all platforms before publication. Preserve these guarantees when changing the release process.
