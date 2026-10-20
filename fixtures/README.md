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

The Rust port should match the semantic output. For YAML, compare parsed data
(`proxies`, `proxy-groups`, `rule-providers`, `rules`) rather than whitespace or
key order. Never replace these fixtures with real subscriptions or node
credentials.
