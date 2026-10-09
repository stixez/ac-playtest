# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Taps and drags failed with "element is outside of the viewport" on phones laid out below the fold when the
  controller uses a `position: fixed` layout (such elements can't scroll the outer page). Device input now scrolls
  the sim page until the target point is in the viewport, for element and `{x, y}` targets.
- The default viewport assumed portrait phones. The sim page now puts phones in a column beside the screen, and the
  default viewport fits two phones there in either orientation (also after `setOrientation`).
- A Unity WebGL screen could take the sim page fullscreen and cover the phones, so every phone tap hit the
  screen. Device frames are no longer allowed to go fullscreen.

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
