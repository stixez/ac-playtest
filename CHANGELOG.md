# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `examples/demo-game`, *Starlight Scramble*: a small, dependency-free party game for the README. Phones steer ships
  with a floating joystick and fire; first to 5 wins.
- `examples/demo-playtest.mjs`: a playtest that plays the demo (reads the ships, steers by touch drag toward an
  opponent, fires until it scores), run by `test/demo.test.js`.
- `docs/demo.gif` and a new `docs/hero.png`, both recorded with ac-playtest by `docs/media.mjs` (needs ffmpeg).
  `docs/hero.mjs` is gone.

## [0.2.1] - 2026-10-13

Fixes from a code review of `joinBeforeLoad` and the phone lifecycle.

### Fixed

- Messages dropped for a phone whose page hadn't loaded no longer count as delivered to it: `phone.messages()`,
  `lastMessage()`, `waitForMessage()` and `sim.messages({ to })` exclude them. The `message` event lists them in
  `undelivered`. Queued messages count once they arrive (new `messageDelivered` event).
- A phone dropped before its page loaded made `addPhone` / `reconnect` wait for the full timeout with a misleading
  error. They now reject at once ("Phone N was dropped before its page loaded"), and waiters are cleaned up. A
  phone dropped before it was ever announced is recorded as a `removed` event.
- `sim.phones()` could return a dropped phone's detached `Device` while it was reconnecting. It now lists only
  phones whose page has loaded. A dropped `Device` throws a clear error (`liveFrame()`) until it reconnects.
- `launch({ phones, joinBeforeLoad })` added phones one `loadDelay` at a time. Phones are now announced one after
  another and their pages awaited together, so several can be announced-but-unloaded at once. Ids and connect
  order stay deterministic.
- Phone timeouts included `loadDelay`, so a long `loadDelay` failed launches. The timeout now excludes it, and
  `launch({ phoneTimeout })` sets the default.
- `reconnect(id, { joinBeforeLoad })` stuck to later reconnects (and stopped `'random'` drawing). It now applies to
  that join only.
- Nickname changes and device motion for a phone that hasn't loaded are now dropped or queued like messages
  (`messageDropped` / `messageQueued` carry an `action`), instead of being posted to a blank frame.
- `seed: 0` was treated as `1`. Invalid `seed` / `loadDelay` now reject in `launch()`. Invalid sim-page query
  settings warn and fall back to the defaults (shown in `state().settings`).
- A test left a promise rejection unhandled while it waited, which could fail on slow CI.

### Changed

- Internals: whether a phone is "announced but not loaded" is derived from the device list. All sends to a phone
  go through one path, and the device data is built by one helper.

## [0.2.0] - 2026-10-13

### Added

- `joinBeforeLoad` (`'never'` default, `'always'`, `'random'` with `seed`) and `addPhone({ joinBeforeLoad })` /
  `reconnect(id, { joinBeforeLoad })`: a phone can appear to the other devices (`onDeviceStateChange` +
  `onConnect`) `loadDelay` ms before its controller page loads, which AirConsole says can happen. This catches
  games that treat "connected" as "controller ready".
- `earlyMessages: 'drop' | 'queue'` for messages to a phone that appeared but hasn't loaded (default `'drop'`, an
  assumption documented in the Fidelity table), with new `messageDropped` / `messageQueued` events. `connect`
  events carry `early: true | false`.
- README: a "Testing robustness" section. The early-join behaviour is part of the API suite, so the official
  library runs it too (now 17 tests).

### Changed

- Fidelity table: two behaviours are now confirmed by the AirConsole team in email (Oct 2026). Custom device-state
  updates are not echoed back to the device that set them, and the server does no player silencing beyond the
  1.11 client logic.
- README notes that AirConsole is working on an updated official simulator.
- `addPhone` / `reconnect` now resolve once the phone's page is ready *and* the others were told, in either order.

## [0.1.0] - 2026-10-09

### Added

- Simulated AirConsole platform (`/__ac/sim.html`): screen frame, phone frames, device list, message routing with
  a JSON round-trip, connect/disconnect/reconnect, ads, pause/resume, premium, profile changes, high scores and
  persistent data (in memory), device motion, safe area, and an event log.
- Independently written stand-in for the AirConsole JS API 1.11 (contains no AirConsole code), served in place of `airconsole-<version>.js`, including
  client-side player silencing.
- `ac-playtest serve <buildDir>` CLI with `--port`, `--host`, `--phones`, `--scale`, `--api-version`,
  `--official-api` and `--open`.
- Static server for AirConsole builds: `Content-Encoding` for `.br` / `.gz`, correct MIME types (`.wasm`),
  `no-store`, API script tag rewriting, single origin.
- Playwright scripting API: `launch()`, `Sim` (phones, platform controls, message and event log, `waitFor*`,
  ads, console errors including API-reported `jserror`s, screenshots) and `Device` (trusted touch / mouse
  `tap` and `drag`, per-device messages, `evaluate`).
- TypeScript definitions, a dummy game, an example playtest, and tests: server, CLI, harness, and an API
  behaviour suite that also runs against the official AirConsole library (opt-in).
- `path` option (`launch({ build, path })`, `serve <root> --path <dir>`): serve a web root and run the game from a
  folder below it, for games that load shared files from parent folders (`../styles/...`).
- README: "Tested with" (a Unity WebGL game, AirConsole's scaffold and API examples, in both API modes), badges
  and a screenshot (`docs/hero.png`, regenerated by `docs/hero.mjs`).
- GitHub issue and pull request templates.

### Fixed (found while dogfooding, before the release)

- Taps and drags failed with "element is outside of the viewport" on phones laid out below the fold when the
  controller uses a `position: fixed` layout (such elements can't scroll the outer page). Device input now scrolls
  the sim page until the target point is in the viewport, for element and `{x, y}` targets.
- The default viewport assumed portrait phones. The sim page now puts phones in a column beside the screen, and the
  default viewport fits two phones there in either orientation (also after `setOrientation`).
- A Unity WebGL screen could take the sim page fullscreen and cover the phones, so every phone tap hit the
  screen. Device frames are no longer allowed to go fullscreen.

[0.2.1]: https://github.com/stixez/ac-playtest/releases/tag/v0.2.1
[0.2.0]: https://github.com/stixez/ac-playtest/releases/tag/v0.2.0
[0.1.0]: https://github.com/stixez/ac-playtest/releases/tag/v0.1.0
