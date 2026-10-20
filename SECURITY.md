# Security

Clash RuleVis is a local-first tool. It must never become a way to leak a user's
subscription URL, node credentials, controller secret, or workspace history.

## Supported versions

Security fixes are made on the latest `main` branch and the latest tagged release.

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability. Use GitHub's private
security advisory flow for this repository:

<https://github.com/youbilin/Clash-RuleVis/security/advisories/new>

Include the affected version, a minimal reproduction, and the impact. Do not
include real subscription URLs, node credentials, or controller secrets — use
redacted examples.

## Security boundaries

- The local service binds `127.0.0.1` and uses a session cookie plus an Origin allowlist.
- Imports and exports are local. The tool does not modify Clash Verge profiles
  and does not trigger a kernel reload.
- Exported YAML never includes source subscription URLs or the controller secret.
- Node credentials are intentionally written to the generated YAML because the
  kernel needs them; treat exported files as secrets.
- Workspace JSON backups contain subscription URLs and node credentials. They
  are local files and must not be attached to public issues.
