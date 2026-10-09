# Contributing

Thanks for helping! Issues and pull requests are welcome.

- **Setup:** Node 20+, then `npm install`. Tests need Chromium: either `npx playwright-core install chromium` or
  an installed Google Chrome.
- **Tests:** `npm test` must pass. Add a test for every behaviour change; AirConsole API behaviour belongs in
  `test/support/api-suite.js` so that it is also checked against the official library
  (`AC_PLAYTEST_OFFICIAL=1 npm run test:official`, needs internet).
- **Fidelity first:** when changing simulated behaviour, cite the source (API docs, the public client library,
  or an observation on real AirConsole) in the PR. If real behaviour is unknown, say so in the README's
  Fidelity table rather than guessing.
- **Clean room:** do not copy code from the AirConsole library or plugins into this repository.
- **Style:** plain modern JavaScript (ESM), small modules, no build step, minimal dependencies. The files in
  `src/sim/` run in the browser inside games' frames, so keep them dependency-free and ES5-friendly.
- **Commits:** small and focused, with a message that explains why.
