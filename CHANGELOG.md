# Changelog

All notable CutLoc changes are recorded here. CutLoc v1.0.0 is the first stable source release; project files continue to use `schemaVersion: 1`.

## Unreleased

### Added

- One-time `npm.cmd run setup:user` registration for the user-level `cutloc` command without an EXE or desktop package.
- `cutloc open`, `cutloc status --json`, `cutloc doctor --json`, `cutloc stop`, and `cutloc restart` runtime workflows.
- Automatic shared-server startup on an available loopback port for live CLI commands.
- A single runtime contract for installation metadata, instance discovery, user storage, logs, and temporary files.
- Dedicated `keyframes list/set/remove/clear` CLI commands and a machine-readable keyframe contract for AI agents.

### Changed

- Text shadows now scale with the same canvas factor as text and strokes, keeping preview and exported typography visually proportional.
- Completed exports now open a dedicated result screen with file details, a primary download action, repeat export, and a path back to the export settings.
- Windows media discovery and probing helpers now run without flashing console windows during import or export preparation.
- Export renderer pages now start in parallel and use Chromium's optimized lossless frame capture path; draft and standard H.264 profiles favor faster presets while preserving their quality targets.
- Export resolution labels now use unambiguous 720p HD, 1080p Full HD, 1440p QHD, and 2160p UHD names with exact pixel dimensions. Output FPS no longer changes the project timeline FPS, and custom video bitrate is entered in Mbps with a profile-aware recommendation.
- Export progress now distinguishes compositor startup, rendered frame count, and final encoding/muxing.
- Windows projects, settings, proxies, backups, and exports now default to `%LOCALAPPDATA%\CutLoc\data` instead of the source checkout.
- Live preview now consumes the shared frame-quantized render plan used by the export contract for layer order, source time, transforms, transitions, crop/fit geometry, adjustment filters, and audio gain. Duplicate animation math was removed from the React compositor, fractional FPS is available in the canvas, and playback publishes at most one UI update per authored frame.
- `agent guide` documents repo-independent discovery and automatic startup.
- Existing checkout-local data is copied after empty runtime scaffolding and safely merged when both locations contain data; destination conflicts and the legacy source remain intact.
- The editor's Animation tab now uses a compact three-step motion workflow. Once a property is enabled, changing it at another playhead position automatically creates or updates the keyframe.

### Fixed

- Project writes now require an explicit revision, locked-track media deletion is rejected, and explicit unlocks retain their clips.
- Clip, track, and style duplication regenerate nested keyframe IDs; invalid keyframe values and ambiguous track ordering are rejected by the shared schema.
- Export ranges outside the timeline are rejected instead of truncated, fractional broadcast frame rates are supported, and export jobs can be cancelled from the browser.
- FFmpeg export publication is atomic, layer order follows `track.order`, hidden video tracks retain their audio unless muted, and the final mix is normalized to 48 kHz stereo with peak limiting.
- Derived media rebuilds use unique temporary files, detect in-place source changes, publish as one rollback-safe transaction, and relink removes superseded derivatives.
- Export preflight now compiles and probes the actual FFmpeg graph, while corrupt project reads return a server error instead of being reported as missing.
- Media removal uses the server lifecycle instead of deleting only local UI state; modal focus containment and timeline keyboard access have also been completed.
- Legacy runtime activity responses fail closed when preview work cannot be observed, preventing an unverified non-forced shutdown.
- Dirty browser edits are mirrored to a validated per-project local draft and recovered after reload; conflicting server changes require an explicit recovery choice.
- Job history is stored atomically across server restarts, and work interrupted by a restart is surfaced as failed instead of disappearing.
- Managed startup now honors checkout `.env` storage overrides instead of forcing the default `DATA_DIR`.
- Runtime status and doctor use the effective project directory, and doctor verifies FFmpeg text rendering.
- Health discovery rejects loopback services that do not identify the CutLoc product and API protocol.
- Background server output is retained in `logs\server.log`, and version changes restart stale managed instances.
- Installed commands ignore unrelated generic `HOST`/`PORT` variables, offline agent guidance no longer advertises a guessed API address, and doctor reports endpoint identity failures as structured checks.
- Persisted installation, instance, and lock records are structurally validated before use; incomplete or unsafe metadata is ignored instead of crashing or redirecting the CLI.
- Runtime protocol v2 exposes active work state. Automatic upgrades and stop/restart no longer interrupt media jobs, while closing an active editor session requires an explicit `--force`.
- Active preview renders are protected from stop/restart, and browser progress streams are closed cleanly so an open editor cannot leave shutdown hanging.
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
- API request budgets, including a tighter limit for browser-composited single-frame rendering.
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
- Preview and MP4 export now use the same Chromium visual compositor; FFmpeg is limited to audio processing and final encoding/muxing for this path.
- Hardware encoding, collaboration, automatic transcription, installer packaging, and lossless cutting are not included.

[1.0.0]: https://github.com/HakanBabus/CutLoc/releases/tag/v1.0.0
