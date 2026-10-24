# Changelog

## 0.5.0 — 2026-10-24

### Changed

- Full monochrome pass across every page. All CSS color literals and the app logo
  were converted to pure grayscale; green, amber, red and blue accents are gone.
- The current navigation item and primary actions now use a solid black anchor.
  Online state uses a filled dot, warnings use dashed borders and hollow rings,
  destructive actions use inverted or black-outlined treatments, and info states
  use quieter grays. Hierarchy now comes from contrast, weight, borders and fill
  style rather than hue.
- Node country flags are grayscaled. Page transitions, layered panel elevation,
  inset highlights and the white/gray depth pass are preserved.

## 0.4.1 — 2026-10-24

### Added

- System tray with “显示主窗口” and “退出”. Closing the main window now asks
  whether to minimize to the tray or quit directly; minimizing keeps live
  connections and background tasks running.
- Explicit node selection mode. Clicking a node row no longer toggles selection;
  press “选择” in the node toolbar, then click rows. The top batch bar supports
  select-all, enable/disable, tags, “加入出口” and clear/finish actions.
- Batch node picker in the exit editor, so multiple existing nodes can be added
  to an exit at once. The nodes page can also add the current selection to an
  existing exit.
- Pasting a share link, subscription URL or YAML into the empty Add Source
  dialog imports it automatically; a “粘贴并添加” clipboard button is also
  available.
- Exit templates now show their current match count. Templates with no matches
  open the editor instead of creating an empty exit, and a new “自选节点”
  template starts from a manual batch selection.

### Changed

- Page switching now uses a short rise-and-fade transition, with the topbar page
  label animating in sync.
- Depth pass across every page: panels, toolbars, table headers, fields, buttons,
  chips, switches and the topbar use layered shadows, subtle gradients and inset
  highlights while keeping the warm white/gray theme.

### Fixed

- Applying a live configuration no longer flashes console windows: the
  `where.exe` lookup used during mihomo discovery is now created with
  `CREATE_NO_WINDOW`, matching the validator and PowerShell probes.
- The exit template menu grid placed the type badge over the name column,
  causing overlapping text. The badge now occupies its own column and the menu
  is slightly wider.
- Nested modals only dismiss the topmost layer on Escape instead of closing the
  drawer underneath.

## 0.4.0 — 2026-10-22

### Added

- Optional **live mode** for the desktop app. Safe mode remains the default.
  Live mode creates a dedicated local Clash Verge profile, copies the active
  profile's nodes, groups, rules and selected policies, and switches Verge to
  it without touching the subscription profile.
- “应用到 Clash Verge” in the topbar is the only action that applies live-mode
  changes. It merges the current workspace while preserving controller, secret,
  ports and unknown settings, validates the full YAML with mihomo, backs up the
  previous profile, writes atomically, and reloads the running kernel through
  `PUT /configs?force=true`. Failures roll the file back and reload the previous
  configuration.
- Closing live mode switches back to the original profile, restores the
  pre-live configuration and keeps the dedicated profile plus backups for later
  re-enablement.
- Topbar safe/live status chip, apply button with pending rule count,
  confirmation dialogs, profile-mismatch detection, and status refresh on focus
  and every 30 seconds. Applying first flushes unsaved workspace edits.
- Live-profile backups live in the app-data `verge-backups/` directory. The
  pre-live seed backup is protected from automatic pruning so safe mode can
  always be restored.
- Unit and integration coverage for live-profile creation, selected-policy
  copying, managed-section merging, controller preservation, apply/disable
  state, and a mocked controller reload. Rust tests now total 33 plus one
  optional real-controller smoke test.

### Changed

- Version bumped to 0.4.0. README, README.en and SECURITY now describe safe mode
  as the default and live mode as an explicit, backed-up opt-in.
- The E2E harness now asks the OS for a free loopback port instead of picking a
  random port that may collide with Windows ephemeral allocations.

## 0.3.3 — 2026-10-21

### Fixed

- Node latency tests now wait 5 seconds and explain when a node is not present
  in the running kernel. Batch tests report success/failure counts, and failed
  rows keep the exact reason in their tooltip.
- Directly imported nodes stay grouped in the single “节点链接” source.
  Deleting the last node of a source removes that source, and empty manual
  sources are pruned when a workspace is normalized.

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
- Export history can be cleared in one action; exported YAML files are kept on
  disk.
- Export storage stats and a 30-day cleanup action; files referenced by history
  or the latest export are protected.

### Changed

- Readability pass across every page: small text was raised again (minimum
  11.5px, most labels 12px), badges auto-size instead of clipping, and dense
  rows keep their layout.
- Topbar navigation is icon-only and left-aligned; the active page name is
  shown next to search, and the live stream pause switch lives in the
  navigation bar.
- Live stream pause/resume uses a dedicated switch control instead of a small
  square button.
- Expanded live connection rows are measured by connection key, so live
  reordering no longer makes the detail panel overlap the following rows; the
  list order is frozen until the detail is collapsed.
- The offline empty state now offers only two actions: re-detect after starting
  Verge, and import a subscription directly. The stream indicator now shows
  “等待内核” instead of a green live state while the kernel is offline.
- Large rule lists are fully virtualized, so 1000+ rules only mount visible
  rows while drag reordering and selection still work.
- README screenshots and the chain demo GIF were regenerated for the current UI.
- Notifications are centered above the app (including dialogs), have no close
  or undo controls, and dismiss automatically after a few seconds.
- The GitHub button now opens the repository in the system browser on desktop.
- The app opens and the workspace stays editable even when Clash Verge is not
  running; kernel status is refreshed in the background instead of blocking the
  boot screen.
- Branding is now Clash RuleVis throughout: boot screen and logo, page title,
  generated YAML header and default export/backup file names.
- The live page exit rail fills the available height instead of leaving a gap,
  and the redundant “管理规则集” footer link was removed.

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
