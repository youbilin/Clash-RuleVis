# Changelog

## 0.3.2 — 2026-10-21

### Added

- Rule set source inspector: click a rule set row (or its globe action) to see
  the provider, type, rule count, runtime mode, full source URL and the derived
  repository URL, with copy/open actions. Available on both the rules page and
  the rule set management page.
- `POST /api/open-url` on both the desktop and web backends (http/https only) so
  external links open in the system browser instead of inside the app.
- Repository URL derivation for raw GitHub, GitHub, jsDelivr and Gitee sources.
- Export confirmation dialog with an editable file name; no file is written
  until “确认导出” or “导入到 Clash Verge” is pressed.

### Changed

- Readability pass across every page: all sub-11px text tokens were raised
  (small labels now at least 10px), badges auto-size instead of clipping, and
  dense rows keep their layout.
- Topbar navigation is now icon-only and left-aligned; the active page name is
  shown next to the search button.
- Live stream pause/resume is a dedicated switch control instead of a small
  square button.
- Notifications are centered above the app (including dialogs), have no close
  or undo controls, and dismiss automatically after a few seconds.
- The GitHub button now opens the repository in the system browser on desktop.
- The app opens and the workspace stays editable even when Clash Verge is not
  running; kernel status is refreshed in the background instead of blocking the
  boot screen.
- Branding is now Clash RuleVis throughout: boot screen and logo, page title,
  generated YAML header and default export/backup file names.
- The live page exit rail fills the available height instead of leaving a gap,
  the stream pause control is larger and has its own column, and the redundant
  “管理规则集” footer link was removed.

### Fixed

- Export completion no longer overflows its footer; the instructional callout
  and extra actions were removed, leaving the confirmation and import actions.

## 0.3.1 — 2026-10-21

### Added

- One-click **Import to Clash Verge**: after a safe export, the app serves the
  YAML from a random loopback URL with a 36-character token, 30-minute TTL and
  opens `clash://install-config`; the URL can also be copied manually.

### Fixed

- Export completion no longer renders the file path as dark-on-dark; it is now
  a readable light surface with a copy button.
- The live page fills the available viewport instead of leaving a large blank
  area below the connection table.
- Live exit cards are denser: test/edit actions moved into the header, hit count
  merged into the meta row, and padding reduced.

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
