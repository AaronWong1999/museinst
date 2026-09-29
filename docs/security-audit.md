# Dependency security review

Reviewed 2026-09-27 with `npm audit --registry=https://registry.npmjs.org`.

The lockfile currently reports **0 critical, 3 high, and 1 moderate** dependency findings. These are recorded here so release decisions do not silently treat a passing critical-only gate as a clean dependency tree.

## Browser installation toolchain

The high findings trace to `extract-zip@2.0.1`, pulled in by `@puppeteer/browsers@2.2.4` from `@cloudflare/puppeteer@1.4.0` ([GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv), [GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3)). They concern untrusted ZIP extraction. MuseInst's Worker does not accept ZIP uploads for local extraction, and its Browser Rendering path does not call that installer. The upstream Cloudflare package pins the affected major version. Forcing a different browser helper across the upstream pin has not been validated against live Browser Rendering, so the dependency remains at the supported version pending an upstream-compatible fix.

## Agents SDK

The moderate finding is on `agents@0.0.60` ([GHSA-r7x9-8ph7-w8cg](https://github.com/advisories/GHSA-r7x9-8ph7-w8cg), [GHSA-cvhv-6xm6-c3v4](https://github.com/advisories/GHSA-cvhv-6xm6-c3v4), [GHSA-w5cr-2qhr-jqc5](https://github.com/advisories/GHSA-w5cr-2qhr-jqc5)). MuseInst imports its base `Agent` class. It does not use the advisory's header-based email resolver or mount the SDK's AI Playground. A compatible SDK upgrade still needs Durable Object persistence and runtime verification.

## Release policy

`npm run audit:deps` blocks critical findings. Review every new high or moderate finding for an exposed application path. Do not apply a forced downgrade solely to silence `npm audit`; verify any dependency replacement with the typecheck, tests, Wrangler dry run, and a live browser smoke test before releasing it.
