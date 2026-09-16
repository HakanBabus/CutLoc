# Changelog

All notable CutLoc changes are recorded here. The project remains a `0.x` beta; project files continue to use `schemaVersion: 1`.

## Unreleased

### Added

- JSON-first CLI project editing, agent discovery, exclusive sessions, streaming uploads/downloads, and preview-frame capture.
- Linux and Windows browser regression jobs with retained failure evidence.
- API request budgets, including a tighter limit for FFmpeg-backed preview rendering.

### Changed

- Browser tests now use disposable project storage and dynamically allocated local ports.
- FFmpeg selection checks text-rendering capability and falls back to a suitable local binary when needed.
- Supported dependency updates are grouped; breaking major updates remain explicit review work.

### Fixed

- Managed asset paths can no longer target project metadata or escape their project folder.
- Project, trash, backup, and derived-media file operations use validated path boundaries.
- CLI sessions cannot access global or different-project endpoints, and normalized API paths cannot leave `/api/`.
- CLI remove plans now fail clearly when a track, clip, or marker does not exist.
- Linux CI text export no longer depends on an FFmpeg build without `drawtext`.

### Known limitations

- CutLoc is local-only beta software and does not sandbox FFmpeg from untrusted media.
- Browser preview and final FFmpeg output may differ for some codecs, typography details, filters, and effect combinations.
- Hardware encoding, collaboration, automatic transcription, installer packaging, and lossless cutting are not included.
