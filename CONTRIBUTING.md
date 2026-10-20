# Contributing

Thanks for helping improve Clash RuleVis.

## Local development

Requires Node.js 22+. The Rust core additionally requires a stable Rust
toolchain; on Windows that means MSVC Build Tools and the Windows SDK.

```bash
npm install
npm run dev
```

- Web UI: <http://127.0.0.1:5273>
- Local API: <http://127.0.0.1:4780>

Run the full local checks before opening a pull request:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run rust:lint
npm run rust:test
```

`test:e2e` uses a temporary data directory and local Chrome; it does not touch
your `data/` workspace. Set `CHROME_PATH` if Chrome is not discovered.

When changing export generation or share-link parsing, update the TypeScript
implementation and the Rust core together. `fixtures/` is the
language-independent contract: run `npm run fixtures:generate` after intentional
output changes and make sure `cargo test` still passes.

## Data safety

- Never commit `data/`, subscriptions, exported YAML, controller secrets, or
  workspace backups.
- When sharing screenshots or reproduction files, redact subscription URLs,
  node addresses, credentials, and any identifying history labels.
- Use the demo workspace (`npm run demo`) for screenshots.

## UI conventions

- Keep the workbench compact: no oversized page titles or boxed hero cards.
- Long tables scroll inside their panel; page chrome stays still.
- Keep controls at stable widths so filters do not shift the search field.
- Prefer one-line status text over explanatory paragraphs.
