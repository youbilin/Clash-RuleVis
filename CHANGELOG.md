# Changelog

## Unreleased

### Added

- `rust/rulevis-core`: Workspace v2 models, normalization, the full YAML
  generator and eight share-link parsers, with a `check` / `generate` /
  `normalize` / `parse-link` CLI.
- Language-independent parity tests against the demo export and link fixtures:
  14 core tests cover export semantics, counts/issues, percent-encoded SS,
  chain relays, disabled members, manual-source merging and privacy regressions.
- `rust/rulevis-app`: testable desktop storage, history, export, Verge base
  template reader and JSON API, independent of the Tauri shell.
- Tauri 2 desktop preview: workspace load/save with revision conflicts, manual
  node import, chains, rule-catalog batch add, YAML preview/diff/export,
  history restore and open-export-directory.
- Frontend runtime bridge: browser builds keep using Fastify, desktop builds use
  a single Tauri IPC command; live status falls back to an empty-state poll.
- Six desktop API tests covering save conflicts, manual nodes, chains, export,
  history restore, source deletion, unavailable endpoints and frontend error
  serialization.
- CI runs `cargo fmt`, `clippy -D warnings` and `cargo test` for both Rust
  crates, plus a Windows job that checks the Tauri shell.

### Notes

- Desktop subscription/YAML import, source refresh, kernel connection/live
  stream, latency tests, ruleset refresh and `verge-mihomo -t` validation are
  still being migrated and return `DESKTOP_UNAVAILABLE` explicitly.
- No Windows installer is published yet. The desktop shell uses Rust IPC only;
  no Electron or Node sidecar is used as a stand-in desktop build.

## 0.2.0 — 2026-10-20

### Added

- Visual chain proxy builder: relay + landing nodes generate an independent
  `dialer-proxy` node without changing the original nodes.
- Batch source import in one modal, with automatic detection of subscription
  URLs, YAML content and node share links.
- One-click refresh for all subscription / Verge sources, including update
  time, remaining traffic and expiry status.
- Duplicate node detection, merge and combined failed / disabled / duplicate
  filters.
- Invalid-target and zero-hit rule filters, plus one-click invalid rule cleanup.
- Live-context quick rules: direct, reject, or route through a favorite exit.
- Workspace JSON backup / restore and an open-export-directory action.
- Playwright smoke test running against a temporary local data directory.

### Changed

- Node rows are selected on click; hover actions provide edit and delete.
- All direct link imports are grouped under one **节点链接** source.
- Direct-link parsing now supports percent-encoded Shadowsocks userinfo, SSR and
  SOCKS5 in addition to SS / VMess / VLESS / Trojan / Hysteria2 / TUIC.
- Disabling or deleting a node removes it from direct exit members so it cannot
  block export.
- Export history is a header dropdown with diff-aware restore.
- The live page no longer shows the target-count subtitle; pause/resume lives
  next to the STREAM status.
- Desktop-first internal scrolling across rules, exits, nodes, live targets and
  export details.
- Vendor chunks are split for a smaller initial bundle.

### Security

- Logs redact URLs and secret-like fields.
- Added privacy regression tests for generated YAML and base settings.

## 0.1.0 — 2026-10-20

- Initial local-first Clash Verge / mihomo workbench: live connections, node and
  subscription imports, policy exits, Chinese MetaCubeX rule catalog, rule
  ordering, safe YAML export, kernel validation and history.
