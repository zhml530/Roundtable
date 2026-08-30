# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for `zhml530/Roundtable`. If private reporting is not enabled, contact a repository maintainer privately before sharing technical details publicly.

Include the affected version or commit, platform, reproduction steps, impact, and any suggested mitigation. Remove API keys, tokens, local prompts, and personal data from logs and screenshots.

## Security boundaries

- The renderer reaches orchestration through the Electron preload bridge; the utility process must not expose an unauthenticated network listener.
- Packaged credentials must remain in operating-system-backed secure storage and must never be returned to the renderer, logs, process arguments, or analytics.
- Provider CLIs run with the current user's operating-system permissions. Approval prompts are the consent boundary for risky agent actions.
- User-controlled values must not be routed through a shell command string.

Reports involving a bypass of these boundaries are in scope.
