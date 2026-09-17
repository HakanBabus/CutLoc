# Changelog

All notable CutLoc changes are recorded here. CutLoc v1.0.0 is the first stable source release; project files continue to use `schemaVersion: 1`.

## Unreleased

### Added

- One-time `npm.cmd run setup:user` registration for the user-level `cutloc` command without an EXE or desktop package.
- `cutloc open`, `cutloc status --json`, `cutloc doctor --json`, `cutloc stop`, and `cutloc restart` runtime workflows.
- Automatic shared-server startup on an available loopback port for live CLI commands.
- A single runtime contract for installation metadata, instance discovery, user storage, logs, and temporary files.

### Changed

- Windows projects, settings, proxies, backups, and exports now default to `%LOCALAPPDATA%\CutLoc\data` instead of the source checkout.
- `agent guide` documents repo-independent discovery and automatic startup.
- Existing checkout-local data is copied after empty runtime scaffolding and safely merged when both locations contain data; destination conflicts and the legacy source remain intact.

### Fixed

- Managed startup now honors checkout `.env` storage overrides instead of forcing the default `DATA_DIR`.
- Runtime status and doctor use the effective project directory, and doctor verifies FFmpeg text rendering.
- Health discovery rejects loopback services that do not identify the CutLoc product and API protocol.
- Background server output is retained in `logs\server.log`, and version changes restart stale managed instances.
- Installed commands ignore unrelated generic `HOST`/`PORT` variables, offline agent guidance no longer advertises a guessed API address, and doctor reports endpoint identity failures as structured checks.
- Persisted installation, instance, and lock records are structurally validated before use; incomplete or unsafe metadata is ignored instead of crashing or redirecting the CLI.
- Runtime protocol v2 exposes active work state. Automatic upgrades and stop/restart no longer interrupt media jobs, while closing an active editor session requires an explicit `--force`.
- User setup writes the command shim atomically and recognizes equivalent expanded or environment-variable-based PATH entries, preventing partial commands and duplicate registration.

### Known limitations

- V1.1 remains a source distribution and still requires Node.js 24.x, npm 11.x, and an initial checkout/install/setup step.
- There is no EXE, installer, desktop shell, or automatic updater.

## [1.0.0] - 2026-09-16

### Highlights

- First supported local source release of the CutLoc web editor, Fastify server, shared project contracts, and JSON-first CLI.
- Complete release gate across builds, shared/server/CLI tests, Chromium browser regressions, production dependency audit, and an isolated end-to-end export smoke test.

### Added

- JSON-first CLI project editing, agent discovery, exclusive sessions, streaming uploads/downloads, and preview-frame capture.
- Linux and Windows browser regression jobs with retained failure evidence.
- API request budgets, including a tighter limit for FFmpeg-backed preview rendering.
- Light, Gray, and Dark editor themes with compact Speed and Animation workflows.

### Changed

- Browser tests now use disposable project storage and dynamically allocated local ports.
- FFmpeg selection checks text-rendering capability and falls back to a suitable local binary when needed.
- Supported dependency updates are grouped; breaking major updates remain explicit review work.
- Fullscreen preview now keeps timecode, total duration, transport controls, and framing tools visible.

### Fixed

- Managed asset paths can no longer target project metadata or escape their project folder.
- Project, trash, backup, and derived-media file operations use validated path boundaries.
- CLI sessions cannot access global or different-project endpoints, and normalized API paths cannot leave `/api/`.
- CLI remove plans now fail clearly when a track, clip, or marker does not exist.
- Linux CI text export no longer depends on an FFmpeg build without `drawtext`.
- Preview and export now scale canvas-space clip positions, animation offsets, and text metrics consistently across output resolutions.
- Non-dark themes no longer inherit conflicting dark editor surfaces, and narrow rail/timeline controls remain centered without overlap.
- Timeline seeking no longer applies a second synthetic click after pointer capture, preventing the playhead from jumping backward on Windows.

### Known limitations

- CutLoc is local-only software and does not sandbox FFmpeg from untrusted media.
- Browser preview and final FFmpeg output share canvas geometry but may differ for some codecs, typography details, filters, and effect combinations.
- Hardware encoding, collaboration, automatic transcription, installer packaging, and lossless cutting are not included.

[1.0.0]: https://github.com/HakanBabus/CutLoc/releases/tag/v1.0.0
