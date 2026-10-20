# Changelog

## 0.3.0 — 2026-10-21

### Added

- Windows desktop release (Tauri 2 + Rust) with an NSIS x64 installer.
- Rust subscription/YAML importer: subscription fetch, base64 payloads, dedupe,
  source refresh, groups, rules, rule providers, Verge profile import and
  traffic/expiry metadata.
- Rust mihomo controller: TCP and Windows named-pipe transports, auto discovery,
  persisted connection settings, rediscovery, node/group latency tests and
  HTTP CONNECT probing.
- Rust live connection aggregator: domains, rule hits, exits/nodes, processes,
  smoothed rates, 40-point history and retention cleanup.
- Rust ruleset support: URL/file inspection, inline expansion, file storage,
  create and refresh.
- Real `mihomo -t` validation in the desktop export flow, with automatic binary
  and geo-file discovery.
- Verge base-template reading for ports, DNS and TUN settings.
- 25 Rust tests including fixture parity, a local HTTP subscription import,
  desktop API end-to-end cases and an ignored real-controller smoke test.
- CI checks the Tauri shell on a Windows runner.

### Changed

- Desktop app no longer returns `DESKTOP_UNAVAILABLE` for core routing features.
- Live updates in the desktop app poll the Rust snapshot at 1s; the web build
  keeps its WebSocket stream.
- Version bumped to 0.3.0.

### Security

- Desktop uses Tauri IPC only; no local HTTP listener and no Node sidecar.
- The installer is currently unsigned; SmartScreen may warn. Code signing and
  auto-update are the next milestone.

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
