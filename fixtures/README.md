# Parity fixtures

These fixtures are the language-independent contract for the upcoming Rust core.
They are generated from the current TypeScript implementation:

```bash
npm run fixtures:generate
```

- `expected/demo-export.yaml` — generated from `demo/workspace.json` without a
  Verge base template.
- `expected/demo-export.json` — expected counts and validation issues.
- `links/parsed.json` — representative SS, SSR, VMess, VLESS, Trojan, Hysteria2,
  TUIC and SOCKS5 share-link parse results.

The Rust port matches the semantic output and consumes these fixtures directly
in `rust/rulevis-core/tests/parity.rs`. For YAML, the test compares parsed data
(`proxies`, `proxy-groups`, `rule-providers`, `rules`) rather than whitespace or
key order. Never replace these fixtures with real subscriptions or node
credentials.
