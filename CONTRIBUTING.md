# Contributing

Use Node.js 22 and install dependencies with `npm ci --ignore-scripts --no-audit --no-fund`.

Before opening a pull request, run:

```bash
npm run verify
npm run audit:deps
npx --no-install wrangler d1 migrations apply DB --local --config .generated/wrangler.jsonc
npx --no-install wrangler deploy --dry-run --config .generated/wrangler.jsonc
```

Keep source-code comments in English. Do not commit credentials, generated secrets, personal data, or private code.

