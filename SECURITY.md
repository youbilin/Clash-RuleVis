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

- The web build binds `127.0.0.1` and uses a session cookie plus an Origin allowlist.
- The desktop app normally uses Tauri IPC only, with a restricted CSP and a
  minimal capability set; it does not ship Node or an Electron/Node sidecar.
- The explicit "Import to Clash Verge" action starts a temporary loopback HTTP
  listener on a random port. It serves only the current exported YAML under a
  random 36-character token for 30 minutes, then expires. It never exposes the
  exports directory.
- The current Windows installer is unsigned. Verify the SHA256 published in the
  GitHub release before running it; SmartScreen may warn about an unknown
  publisher.
- Desktop data (workspace, history snapshots, exports and rule-set files) lives
  in the platform app-data directory. Treat that directory as secret.
- The web and desktop builds default to safe mode: exports are local and the tool
  does not modify Clash Verge profiles or trigger a kernel reload.
- Desktop live mode is opt-in and requires explicit confirmation. It creates a
  dedicated local profile named "Clash RuleVis 实时" and never modifies the active
  subscription profile. Every apply backs up the previous profile into the
  app-data `verge-backups/` directory, validates the merged YAML, writes
  atomically, and reloads the mihomo controller with `PUT /configs?force=true`.
  Disabling live mode switches back to the original profile and restores the
  pre-live configuration.
- Live-profile backups contain node credentials and complete routing config.
  They are local sensitive files; never attach them to a public issue.
- Exported YAML never includes source subscription URLs or the controller secret.
- Node credentials are intentionally written to the generated YAML because the
  kernel needs them; treat exported files as secrets.
- Workspace JSON backups contain subscription URLs and node credentials. They
  are local files and must not be attached to public issues.
