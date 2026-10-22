<div align="center">

# Clash RuleVis

**A local-first visual routing workbench for Clash Verge / mihomo**

See every request as **domain → rule → policy group → node**, then edit, reorder and validate the routing without hand-writing YAML.

[中文](README.md) · [English](README.en.md)

[![CI](https://github.com/youbilin/Clash-RuleVis/actions/workflows/ci.yml/badge.svg)](https://github.com/youbilin/Clash-RuleVis/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-356049)
![Local first](https://img.shields.io/badge/local--first-no%20telemetry-356049)

</div>

<p align="center">
  <img src="docs/assets/chain-demo-0.3.2.gif" width="900" alt="Selecting a relay and landing node in the chain builder" />
</p>

<p align="center">
  <sub>Demo data only. A chain node is a new independent proxy and does not reroute the relay or landing nodes.</sub>
</p>

---

> The web workbench and the Windows desktop app are both available. The desktop build is powered by Tauri 2 and Rust with no Node process, Electron or Node sidecar. The current installer is unsigned, so SmartScreen may warn about an unknown publisher.

## What it is

Clash routing is spread across subscriptions, policy groups, `rule-providers` and several YAML files. A rule edit often means guessing whether it matches, which policy group it uses, and which node actually carries the traffic.

Clash RuleVis is a local workbench (web and Windows desktop) that connects to a running mihomo controller, shows the live path, lets you drag domains into rules, manage policy groups, and export or apply a complete validated YAML.

**Safe mode is the default, and remains the product's core constraint:**

- It never writes Clash Verge configuration or profiles.
- It never reloads the kernel.
- Exports are written only to the tool's own directory for manual import.
- Subscription URLs, node credentials and the controller secret stay on the local machine.

If you want edits to take effect directly, the desktop app offers an optional **live mode**. It writes only to a dedicated local profile, backs up the previous file, and reloads the kernel after you explicitly press **Apply to Clash Verge**. It never modifies your subscription profile.

## Highlights

- **Live paths**: active connections, rates, traffic, processes, matched rule and final node; drag a domain onto an exit or a single node.
- **Chinese rule catalog**: all MetaCubeX `meta-rules-dat` geosite/geoip entries with Chinese names, recommended combos, lazy-loaded catalog and priority management in one list.
- **Batch imports**: one dialog accepts multiple subscription URLs, YAML payloads or node links; each row is auto-detected.
- **Node health**: single/all latency tests, persisted results, failed/disabled/duplicate filters, duplicate merge.
- **Visual chain proxy**: left relay + right landing generates a new independent node using `dialer-proxy`; original nodes are untouched.
- **Safe export**: full YAML, diff against previous export, real `verge-mihomo -t` validation, history dropdown with diff-aware restore.
- **Live mode (desktop, opt-in)**: switch to a dedicated local Verge profile, press Apply to merge the current workspace, back up and reload the kernel, then switch back to the original profile at any time.
- **Local data tools**: workspace JSON backup/restore, export confirmation with a custom file name, open export directory, export storage stats with 30-day cleanup, one-click Clash Verge import.
- **Large directories**: live connections and rules are virtualized, so 1000+ entries stay responsive without hiding data behind pagination.
- **Offline editing**: start the workbench before Verge; kernel status refreshes in the background and the app offers re-detect plus subscription import.
- **Desktop-first layout**: dense lists, internally scrolling tables and no page-level scroll on long lists.

## Screenshots

<p align="center">
  <img src="docs/assets/nodes.png" width="49%" alt="Nodes and sources" />
  <img src="docs/assets/rules.png" width="49%" alt="Rule priority and targets" />
</p>
<p align="center">
  <img src="docs/assets/import-sources.png" width="49%" alt="Batch source import" />
  <img src="docs/assets/export.png" width="49%" alt="YAML export" />
</p>

<p align="center"><sub>Screenshots use the fake demo workspace; no real subscriptions or node addresses are included.</sub></p>

## Quick start

Requires Node.js 22+.

### Demo (fake data, no kernel required)

```bash
npm install
npm run demo
```

Open <http://127.0.0.1:4781>. The demo uses an isolated `.demo-data` directory and never reads or writes your `data/` workspace.

### Development

```bash
npm install
npm run dev
```

- UI: <http://127.0.0.1:5273>
- Local API: <http://127.0.0.1:4780>

### Production build

```bash
npm run build
npm start
```

Fastify serves `dist/` at <http://127.0.0.1:4780>.

## Tests

```bash
npm run typecheck
npm test
npm run test:e2e
npm run rust:test
npm run desktop:check
```

40 web unit tests plus 31 Rust tests, a Playwright smoke flow and an optional real-controller test. The E2E flow verifies offline entry and subscription import, imports nodes, merges duplicates, creates an exit and a chain node, cleans invalid rules, exports, restores and clears history, checks a 300-rule virtualized list, cleans orphan export files and round-trips a workspace backup.

## Windows download

Download the latest `Clash.RuleVis_x.x.x_x64-setup.exe` (NSIS, per-user) from [GitHub Releases](https://github.com/youbilin/Clash-RuleVis/releases/latest). The installer is unsigned, so SmartScreen may warn; the release page includes a SHA256 checksum.

Desktop data lives in `%APPDATA%\io.github.youbilin.clash-rulevis` (override with `CRS_DATA_DIR`) and is independent from the web build's `data/`. Import a web workspace JSON backup from the desktop settings drawer to migrate.

## Desktop app (Tauri 2)

The desktop app keeps the same React UI and uses Rust for the local API. It does not start an HTTP server or a Node sidecar.

- Independent workspace storage, revision conflicts, history restore and backup import.
- Subscription URL, YAML paste, local file and active Verge profile import; source refresh with traffic and expiry metadata.
- Manual share links, node/exit editing, chains, rule-catalog batch add, ruleset file/URL inspect and refresh.
- mihomo controller discovery over TCP and Windows named pipes; connection settings, rediscovery and node/exit latency tests.
- Live connection aggregation with domains, rule hits, exits/nodes, processes, rates and history.
- Full YAML preview, diff, real `verge-mihomo -t` validation, safe export and history restore.
- One-click Clash Verge import: serves the current export on a temporary loopback URL and opens `clash://install-config`; the URL can also be copied manually.
- Read-only Verge profile discovery for base port/DNS/TUN settings.
- Live mode: creates and switches to a dedicated local profile, applies the workspace on demand, backs up before writing, reloads the kernel, and restores the original profile on exit.

```bash
npm run desktop:dev    # Tauri window + Vite
npm run desktop:check  # Rust compile check for the shell
npm run desktop:build  # Release build + NSIS installer
```

Windows builds need Rust stable, MSVC Build Tools with the C++ workload, Windows SDK 10 and the WebView2 runtime. Live features require Clash Verge Rev / mihomo.

Safety boundary: safe mode is the default and never writes a Verge profile or reloads the kernel. Live mode is explicit: it writes only to the Clash RuleVis local profile, backs up the previous file into the app-data directory, and reloads the kernel after you press Apply. Disabling it switches back to the original profile and restores the pre-live configuration. Subscription URLs and the controller secret never appear in exported YAML.

## Rust core

`rust/rulevis-core` is the shared foundation for workspace normalization, YAML generation and share-link parsing. It currently covers:

- Workspace v2 serde models and the same normalization rules as the web app.
- The complete YAML generator, including exit resolution, providers, rule priority and validation issues / counts.
- SS, SSR, VMess, VLESS, Trojan, Hysteria2, TUIC and SOCKS5 links, including percent-encoded SS, Reality, ws/grpc and obfs.
- A small CLI with `check`, `generate`, `normalize` and `parse-link`.

The web build still uses Fastify; the desktop shell calls Rust directly. Parity tests use [fixtures](fixtures/README.md) as a language-independent contract and compare parsed YAML semantics, not indentation. `rust/rulevis-app` contains the testable desktop storage/export/API layer, while `src-tauri` only hosts the window and IPC command.

```bash
cd rust
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p rulevis-core -- check ../demo/workspace.json
```

CI runs the Rust workspace tests, the desktop API tests and a Windows Tauri shell check. The installer is built with `npm run desktop:build` and signed releases are the next step.

## Data

Runtime data lives in `data/` by default:

```text
data/
├── workspace.json
├── history/
├── exports/
└── rule-sets/
```

Override it with `CRS_DATA_DIR`. `data/`, `.demo-data/` and exported files are excluded from git.

## Safety and privacy

- The web build binds `127.0.0.1` with a local session cookie and Origin allowlist; the desktop build normally uses Tauri IPC only. Importing into Verge temporarily opens a random loopback port with a random token and a 30-minute TTL.
- Live mode is off by default and requires an explicit confirmation. It writes only the dedicated Clash RuleVis local profile, backs up the previous file under the app-data directory, and reloads the kernel only when Apply is pressed.
- Live mode snapshots the current nodes and rules. Subscription refreshes are not propagated automatically; refresh the source and apply again.
- No telemetry or third-party analytics.
- Export YAML excludes subscription source URLs, `external-controller` and `secret`.
- Node credentials are intentionally present in exported YAML because the kernel needs them; treat exported files as secrets.
- Workspace backups, live-profile backups and the desktop app-data directory contain subscription URLs and node credentials; keep them local.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Roadmap

- **v0.3**: Tauri 2 + Rust desktop app with subscription/YAML import, TCP/named-pipe controller, live connections, latency tests, rulesets, mihomo validation and an NSIS installer.
- **v0.4 (current)**: optional live mode — switch to a dedicated local profile, press Apply to merge, back up and reload the kernel, and restore the original profile at any time.
- **Rust foundation**: `rulevis-core` + `rulevis-app` ship 33 automated tests covering fixture parity, desktop API, live-profile merge/restore and the reload request, plus an optional real-controller smoke test.
- **Next**: code signing, auto-update, tray, multi-hop chains and Proxy Provider support.
- **Platform**: Windows x64 installer today; the web build runs on any Node.js 22+ host. The installer is unsigned, and live features require Clash Verge Rev / mihomo.
- A pure Rust UI rewrite is not a goal unless the WebView is proven to be the bottleneck.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Never commit `data/`, real subscription URLs, node credentials or exported YAML.

## Acknowledgements

- [linux.do](https://linux.do/) — Chinese tech community; thanks for the discussion, feedback and launch support.
- [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) — geosite / geoip rule data.
- [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) — kernel and controller API.
- [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) — runtime configuration and usage context.
- React, Vite, Fastify, dnd-kit, TanStack Virtual and lucide-react.

## License

[MIT](LICENSE).

If this tool saves you time, a Star, issue or pull request is welcome.
