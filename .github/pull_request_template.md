## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## Checklist

- [ ] `npm test` passes
- [ ] Behaviour changes have a test (AirConsole API behaviour goes in `test/support/api-suite.js`, so it also runs
      against the official library with `AC_PLAYTEST_OFFICIAL=1 npm run test:official`)
- [ ] Simulated behaviour cites its source (docs, the public library, an observation), or the README's Fidelity
      table says it is unverified
- [ ] README / `index.d.ts` / CHANGELOG updated if the public API changed
- [ ] No AirConsole code copied into the repository
