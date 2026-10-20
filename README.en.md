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
  <img src="docs/assets/chain-demo.gif" width="900" alt="Selecting a relay and landing node in the chain builder" />
</p>

<p align="center">
  <sub>Demo data only. A chain node is a new independent proxy and does not reroute the relay or landing nodes.</sub>
</p>

---

> This repository currently ships a local web workbench. Its Rust core is now fixture-aligned; the Tauri 2 shell and Windows installers are the next milestone. No Electron/Node sidecar is being presented as the final desktop app.

## What it is

Clash routing is spread across subscriptions, policy groups, `rule-providers` and several YAML files. A rule edit often means guessing whether it matches, which policy group it uses, and which node actually carries the traffic.

Clash RuleVis is a local web workbench that connects to a running mihomo controller, shows the live path, lets you drag domains into rules, manage policy groups, and export a complete validated YAML.

**Safe mode is a product constraint, not a setting:**

- It never writes Clash Verge configuration or profiles.
- It never reloads the kernel.
- Exports are written only to the tool's own directory for manual import.
- Subscription URLs, node credentials and the controller secret stay on the local machine.

## Highlights

- **Live paths**: active connections, rates, traffic, processes, matched rule and final node; drag a domain onto an exit or a single node.
- **Chinese rule catalog**: all MetaCubeX `meta-rules-dat` geosite/geoip entries with Chinese names, recommended combos, lazy-loaded catalog and priority management in one list.
- **Batch imports**: one dialog accepts multiple subscription URLs, YAML payloads or node links; each row is auto-detected.
- **Node health**: single/all latency tests, persisted results, failed/disabled/duplicate filters, duplicate merge.
- **Visual chain proxy**: left relay + right landing generates a new independent node using `dialer-proxy`; original nodes are untouched.
- **Safe export**: full YAML, diff against previous export, real `verge-mihomo -t` validation, history dropdown with diff-aware restore.
- **Local data tools**: workspace JSON backup/restore, open export directory, copy Verge import steps.
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
```

40 unit tests plus a Playwright smoke flow that imports nodes, merges duplicates, creates an exit, creates a chain node, cleans invalid rules, exports, restores history and round-trips a workspace backup. E2E uses a temporary data directory and local Chrome; set `CHROME_PATH` if needed.

## Rust core (migration in progress)

`rust/rulevis-core` is the desktop foundation for workspace normalization, YAML generation and share-link parsing. It currently covers:

- Workspace v2 serde models and the same normalization rules as the web app.
- The complete YAML generator, including exit resolution, providers, rule priority and validation issues / counts.
- SS, SSR, VMess, VLESS, Trojan, Hysteria2, TUIC and SOCKS5 links, including percent-encoded SS, Reality, ws/grpc and obfs.
- A small CLI with `check`, `generate`, `normalize` and `parse-link`.

It is not wired into the web runtime yet. Parity tests use [fixtures](fixtures/README.md) as a language-independent contract and compare parsed YAML semantics, not indentation.

```bash
cd rust
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p rulevis-core -- check ../demo/workspace.json
```

CI runs a dedicated `Rust core parity` job. Building Windows installers later requires MSVC Build Tools, the Windows SDK and WebView2; no desktop installer is published yet.

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

- Binds `127.0.0.1` only, with a local session cookie and Origin allowlist.
- No telemetry or third-party analytics.
- Export YAML excludes subscription source URLs, `external-controller` and `secret`.
- Node credentials are intentionally present in exported YAML because the kernel needs them; treat exported files as secrets.
- Workspace backups contain subscription URLs and node credentials; keep them local.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Roadmap

- **v0.2**: current local web workbench and complete import/rules/chain/export loop.
- **Rust foundation (done)**: `rulevis-core` covers normalization, config generation and link parsing with 13 parity tests in CI.
- **Next**: Tauri 2 shell with the React UI; wire in Rust workspace storage and export, then migrate the kernel adapter and subscription importer before publishing signed Windows installers.
- **Later**: more protocols, proxy providers, tray, signed auto-update.
- A pure Rust UI rewrite is not a goal unless the WebView is proven to be the bottleneck.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Never commit `data/`, real subscription URLs, node credentials or exported YAML.

## License

[MIT](LICENSE).

If this tool saves you time, a Star, issue or pull request is welcome.
