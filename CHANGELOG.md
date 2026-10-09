# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-09

### Added

- Simulated AirConsole platform (`/__ac/sim.html`): screen frame, phone frames, device list, message routing with
  a JSON round-trip, connect/disconnect/reconnect, ads, pause/resume, premium, profile changes, high scores and
  persistent data (in memory), device motion, safe area, and an event log.
- Clean-room stand-in for the AirConsole JS API 1.11, served in place of `airconsole-<version>.js`, including
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
