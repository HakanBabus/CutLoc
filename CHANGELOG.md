# Changelog

All notable CutLoc changes are recorded here. CutLoc v1.0.0 is the first stable source release; project files continue to use `schemaVersion: 1`.

## Unreleased

No changes yet.

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

### Known limitations

- CutLoc is local-only software and does not sandbox FFmpeg from untrusted media.
- Browser preview and final FFmpeg output share canvas geometry but may differ for some codecs, typography details, filters, and effect combinations.
- Hardware encoding, collaboration, automatic transcription, installer packaging, and lossless cutting are not included.

[1.0.0]: https://github.com/HakanBabus/CutLoc/releases/tag/v1.0.0
