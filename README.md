<!-- markdownlint-disable MD013 MD033 MD041 -->

[English](README.md) | [Türkçe](README.tr.md)

<div align="center">
  <img src="apps/web/public/favicon.svg" width="88" height="88" alt="CutLoc logo" />
  <h1>CutLoc</h1>
  <p><strong>A local-first video editor for creative work.</strong></p>

  [![Stable](https://img.shields.io/badge/status-stable-35c48d)](#project-status)
  [![Version](https://img.shields.io/badge/version-1.1.0-7c8cff)](#project-status)
  [![CutLoc CI](https://github.com/HakanBabus/cutloc/actions/workflows/ci.yml/badge.svg)](https://github.com/HakanBabus/cutloc/actions/workflows/ci.yml)
  [![CodeQL](https://github.com/HakanBabus/CutLoc/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/HakanBabus/CutLoc/actions/workflows/github-code-scanning/codeql)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
</div>

> [!IMPORTANT]
> **CutLoc v1.1.0 keeps the source distribution while removing repeat setup from daily use.** After one user setup, `cutloc` works from any directory, starts the shared local server when needed, and stores runtime data outside the checkout.

CutLoc is a single-user video editor that runs on your own computer. It combines a media library, multi-track timeline, live canvas, clip **Inspector**, project recovery, and local FFmpeg export in one browser-based workspace.

Use it directly in the browser, automate it from the terminal, or let an **AI coding agent edit through the CutLoc CLI**. The CLI exposes the same local validation, revision, backup, and project-access rules as the web editor, so AI-assisted edits do not need to bypass the application or write project files by hand.

The project remains intentionally focused: it is a practical local editing environment, not a hosted production platform.

![CutLoc dashboard - full page](assets/screenshots/cutloc-dashboard-full.jpg)

## Contents

- [What CutLoc does](#what-cutloc-does)
- [Edit yourself or with an AI agent](#edit-yourself-or-with-an-ai-agent)
- [Feature map](#feature-map)
- [Editor workflow](#editor-workflow)
- [Project status](#project-status)
- [v1.1.0](#v110)
- [Technology](#technology)
- [Quick start](#quick-start)
- [CLI and automation](#cli-and-automation)
- [Local data and configuration](#local-data-and-configuration)
- [Verification](#verification)
- [Safety boundaries](#safety-boundaries)
- [Documentation map](#documentation-map)
- [Contributing](#contributing)
- [License](#license)

## What CutLoc does

CutLoc is built around a clear local-first boundary:

- Projects, imported media, derived previews, backups, and exports are stored on the local machine.
- The API binds to a loopback address by default and is intended for one local user.
- Editing happens in a browser UI backed by a local Fastify server.
- Media probing, derived files, previews, and exports use the FFmpeg/ffprobe binaries supplied through the project dependencies.
- The local CLI uses the same API and validation boundary as the web editor, which makes it suitable for provider-neutral AI-tool automation.

CutLoc is not a hosted video platform, collaboration service, public upload endpoint, remote-rendering service, or built-in transcription product. CutLoc does not promise identical browser/FFmpeg output for every codec and effect combination.

## Edit yourself or with an AI agent

CutLoc has two first-class control surfaces over the same local project:

| You want to… | Use | What you get |
| --- | --- | --- |
| Edit visually | **Web editor** | Media library, canvas, Inspector, timeline, undo/redo, autosave, and export |
| Ask an agent to make edits | **CutLoc CLI** | Machine-readable project context, complete timeline access, safe revision checks, and exclusive edit leases |
| Mix both workflows | **Web + CLI** | Work visually, hand the project to an agent, then continue in the browser when the CLI releases access |

An AI agent can inspect a project, add or relink media, edit tracks and clips, change canvas/text/filter/transition/keyframe data, run export preflight, start an export, monitor jobs, and use backups. The CLI remains **provider-neutral**: CutLoc does not upload the project or choose an AI service for you.

```powershell
# Machine-readable capability and safety guide
cutloc agent guide

# Live server, project, media-health, backup, and job context
cutloc agent inspect <project-id>
```

Every successful command above is a single compact JSON value on `stdout`; failures are JSON on `stderr`. This makes the interface predictable for tool-using agents and shell automation.

## Feature map

| Surface | Current capability |
| --- | --- |
| **Dashboard and projects** | Browse consistent 16:9 project cards, inspect duration, media count, aspect ratio, and on-disk size, then open or move a project directly to trash. |
| **Media library** | Import video, audio, and image files; search, filter, preview, switch between list/card views, inspect media health, rebuild derived files, and drag assets to the timeline. |
| **Timeline** | Arrange video, overlay, audio, text, and subtitle tracks with frame-aware playhead positioning, markers, snapping, trim, split, move, duplicate, ripple-delete, undo/redo, and track lock/hide/mute controls. |
| **Canvas and Inspector** | Select visible objects from the canvas, choose aspect and fit modes, zoom and pan the preview, then edit layout, crop, speed, audio, filters, masks, fades, transitions, keyframes, and text styling. |
| **Motion and building blocks** | Use text presets and add built-in backgrounds or shapes from the Elements panel. The selected clip's Animation tab owns entrance/exit presets, timing, direction, easing, intensity, and keyframes. |
| **Export** | Run local export preflight and render MP4 video or MP3/WAV audio with selectable aspect, resolution, FPS, quality, audio bitrate, and timeline range. Current export is creative re-encoding, not lossless/remux cutting. |
| **Recovery and safety** | Autosave, revision checks, backups, 30-day recoverable trash, project access leases, export preflight, and partial-output cleanup keep local failures visible and recoverable where supported. |

## Editor workflow

### 1. Create a local project

From the dashboard, create a blank project or continue a draft. On Windows, runtime files live under `%LOCALAPPDATA%\CutLoc\data` by default.

### 2. Add and organize media

Open **Media** to import video, audio, or image files. Search and filter the library, preview an asset, or drag it into a compatible timeline track. Open **Elements** for built-in backgrounds and shapes.

### 3. Cut and arrange

Use the **Timeline** to trim either edge of a clip, split at the playhead, move clips with frame precision, snap to useful boundaries, add markers, and use undo/redo. Tracks can be added, renamed, reordered, duplicated, locked, hidden, muted, or deleted.

### 4. Shape the picture and sound

The **Canvas** and **Inspector** work together. Choose `16:9`, `9:16`, `1:1`, `4:5`, `3:2`, or `21:9`; select fit, fill, or smart framing; then adjust position, scale, rotation, flip, opacity, speed, crop, audio, filters, masks, fades, entrance/exit animation, keyframes, and text styles. Animation controls appear only for the selected clip.

### 5. Preview, save, and export

Use the transport controls and frame-aware playhead to review the edit. Autosave and revision checks protect the local project while you work. When the edit is ready, run export preflight and render locally as **MP4**, **MP3**, or **WAV**.

![CutLoc editor with media library, canvas, Inspector, and timeline](assets/screenshots/cutloc-editor.jpg)

## Project status

**Current development version: `1.1.0`.** It preserves the v1 project format while adding a user-level command, shared runtime discovery, and automatic local-server startup.

| Area | Status in v1.1.0 |
| --- | --- |
| Dashboard, project metadata, and project storage | Available locally; cards report the current project-folder size |
| Video, audio, and image import | Available; codec support depends on the installed FFmpeg build |
| Media search, filtering, sorting, list/card views, and derived previews | Available locally |
| Multi-track timeline editing | Available; still evolving |
| Canvas, Inspector, motion, text, shapes, and adjustment layers | Available; parity varies by media and effect combination |
| MP4, MP3, and WAV export | Available through local FFmpeg; output is re-encoded |
| Autosave, revision checks, backups, and trash recovery | Available locally; trash defaults to automatic removal after 30 days |
| English and Turkish interface | Dictionary-based coverage; some legacy labels and copy may still be incomplete |
| Local CLI and AI-tool automation | Available through the loopback API with exclusive project access leases |
| Hosted or collaborative editing | Not supported |
| Built-in transcription or hosted AI editing | Not part of the current editor scope |

The exact import/export boundaries and development contracts are maintained as internal engineering notes; they are intentionally not reproduced in this public README.

## v1.1.0

CutLoc v1.1.0 builds on the first stable source release:

- Preview and FFmpeg export use the same canvas-space positioning when output resolution changes.
- The Light, Gray, and Dark themes share coherent editor surfaces; compact Speed and Animation controls remain fully keyboard-accessible.
- Fullscreen preview retains its timecode, duration, transport controls, and framing tools.
- A one-time `setup:user` command registers `cutloc` on the user PATH; `cutloc open` starts or reuses the shared server and opens the browser editor.
- `cutloc stop` and `cutloc restart` provide an explicit shared-server lifecycle; live commands automatically replace an incompatible managed server. Stop/restart refuses to interrupt active media jobs, and active editor sessions require an explicit `--force`.
- `cutloc status --json` and `cutloc doctor --json` expose machine-readable runtime, version, storage, tool, and compatibility checks.
- The JSON-first CLI retains revision-aware edit plans, project leases, media workflows, recovery, preview-frame capture, and export automation.
- Project storage boundaries, request budgets, autosave merging, backups, recoverable trash, and partial-export cleanup are covered by automated tests.

The project format remains on `schemaVersion: 1`. During `setup:user`, an existing checkout-local `data/` directory is copied when the new destination is empty or contains only runtime-created empty folders. If both locations contain data, missing legacy projects and trash entries are merged without overwriting destination conflicts. The legacy copy is always retained and conflicts are listed in the setup result.

## Technology

- **React 19** and **Vite** for the editor interface
- **TypeScript** across the client, server, CLI, and shared contracts
- **Zustand** and **Immer** for editor state and immutable project updates
- **Fastify** for the loopback-only local API
- **Zod** for shared runtime validation
- **FFmpeg / ffprobe** for probing, proxies, thumbnails, waveforms, and export
- **Playwright** for browser regression coverage
- **Node.js 24.x** in continuous integration

## Quick start

### Requirements

- Windows 10 or 11 is the current primary target.
- Node.js 24.x and npm 11.x are required for a source installation.
- A Chromium-based browser is recommended for the current web interface and browser tests.
- FFmpeg and ffprobe are supplied through the project dependencies for the supported local workflow.

### Clone and install

```powershell
git clone https://github.com/HakanBabus/cutloc.git
cd cutloc
npm.cmd ci
npm.cmd run doctor
npm.cmd run setup:user
```

Open a new terminal after the first setup, then start CutLoc from any directory:

```powershell
cutloc open
```

`setup:user` builds CutLoc, creates a user-level command shim, adds `%LOCALAPPDATA%\CutLoc\bin` to the user PATH, and prepares user storage. It does not install an EXE or desktop application.

### Run in development mode

```powershell
npm run dev
```

This starts Vite at `http://127.0.0.1:5173` and the Fastify API at `http://127.0.0.1:4173`. Vite proxies local `/api` requests to the Fastify port.

On Windows PowerShell, use the `.cmd` form if the local execution policy blocks the `npm` shim:

```powershell
npm.cmd ci
npm.cmd run dev
```

### Run a production-style local build

```powershell
npm start
```

This builds all workspaces and starts the local server at `http://127.0.0.1:4173`. On Windows, the server opens the local URL automatically unless `NO_OPEN=1` is set.

The local server started by `npm run dev` and `npm start` loads the optional root `.env` file through Node.js 24's native environment-file support. The Vite development proxy and root CLI scripts follow the same local `HOST` and `PORT` values; `WEB_PORT` controls the development UI port. Existing process environment variables take precedence, and a missing `.env` file is allowed.

## CLI and automation

CutLoc includes a JSON-first CLI for managing existing projects, applying complete project edits, importing media, restoring backups, starting exports, and accessing supported JSON API routes. It talks to the same local Fastify API as the browser editor; it never edits managed project files directly.

After `setup:user`, inspect the command surface from any directory. Live commands start the shared server automatically; `status` is read-only and never starts it:

```powershell
cutloc --help
cutloc status --json
cutloc doctor --json
cutloc stop
cutloc restart
```

For an AI agent or another JSON consumer, start with the machine-readable guide and live inspection commands. The `cli:agent` script suppresses npm lifecycle chatter and enables compact JSON automatically:

```powershell
cutloc agent guide
cutloc agent inspect --no-guide --limit 20
cutloc agent inspect <project-id>
```

For many calls, build once and invoke the executable directly to avoid rebuilding on every command:

```powershell
npm.cmd run build:shared
npm.cmd run build:runtime
npm.cmd run build:cli
node apps/cli/dist/index.js --compact agent inspect <project-id>
```

The overview form of `agent inspect` is compact and paginated by default. Use
`--cursor`, `--limit`, `--no-guide`, or `--full` to control its payload.

The user CLI discovers the current loopback API from `%LOCALAPPDATA%\CutLoc\runtime\instance.json`. If no live instance exists, live commands start one on an available port. `--url` and `CUTLOC_URL` remain explicit overrides. The repository's development CLI wrapper also follows `.env` `HOST` and `PORT`; the installed command intentionally ignores those generic variable names so unrelated development tools cannot redirect CutLoc. Non-loopback hosts are rejected.

### AI-tool project editing

An AI tool can fetch the current project JSON, edit it locally, and apply it while preserving the server's **revision** value:

```powershell
cutloc projects get <project-id> --out project.json
cutloc projects apply <project-id> --file project.json
```

The server validates the complete document with the shared **ProjectSchema**. If another client changed the project first, the apply returns a conflict instead of silently overwriting that work.

For safer agent-authored timeline changes, prefer a revision-aware edit plan:

```powershell
cutloc projects edit <project-id> --file edit-plan.json --dry-run
cutloc projects edit <project-id> --file edit-plan.json
```

Short-form projects can start with the correct canvas immediately:

```powershell
cutloc projects create "Short demo" --preset shorts
cutloc media add-many <project-id> scene-01.png voice.mp3 --wait
cutloc jobs wait <job-id> --timeout 300
```

For a sequence of JSON operations, use a persistent session:

```powershell
cutloc session <project-id>
```

The session reads one JSON request per stdin line and writes one JSON result per line:

```json
{"method":"GET","path":"/api/projects/<project-id>"}
{"method":"PATCH","path":"/api/projects/<project-id>","body":{"name":"Edited locally","revision":3}}
```

Project-changing commands acquire an exclusive, short-lived project lease. If the project is open in the browser, the CLI can take control and the web editor shows a read-only warning until the command or session ends. A crashed CLI cannot leave a permanent lease because the heartbeat expires.

| Area | Commands |
| --- | --- |
| Runtime | `open`, `status --json`, `doctor --json`, `stop`, and `restart` |
| Agent discovery | `agent guide` and compact/paginated `agent inspect [project-id]` |
| Projects | `projects list/create/get/edit/apply/duplicate/delete/import/bundle` |
| Media | `media add/add-many/remove/relink/rebuild/health/stock` |
| Recovery | `backups list/restore` and `trash list/restore/delete` |
| Export | `export preflight/start` and `jobs list/get/wait/watch/cancel/download` |
| Settings | `settings get/set` |
| Low-level API | `api <method> </api/path>` |

Use dedicated media and project-bundle commands for uploads and binary files. The generic `api` and `session` commands do not stream the `/api/events` SSE endpoint; use `--out` when downloading a binary response.

## Local data and configuration

By default, Windows runtime files are written outside the checkout:

```text
%LOCALAPPDATA%\CutLoc\
├── bin\
├── logs\
│   └── server.log
├── runtime\
├── temp\
└── data\
    ├── projects/
    │   └── <project-id>/
    │       ├── project.json
    │       ├── media/
    │       ├── proxies/
    │       ├── thumbnails/
    │       ├── waveforms/
    │       ├── backups/
    │       └── exports/
    ├── trash/
    └── settings.json
```

`CUTLOC_HOME` overrides the complete user-runtime root for isolated testing. `DATA_DIR` overrides only project/settings storage and is honored by managed `cutloc` startup whether it comes from the process environment or the registered checkout's `.env`. `status` and `doctor` report and test the active configured directory. Detached server output is retained in `logs\server.log`. The repository includes an [`.env.example`](.env.example) with development overrides. Never commit `.env`, API keys, project media, exports, or runtime data.

## Verification

Run the focused checks while developing, or use the full baseline before opening a pull request:

| Check | Command | Covers |
| --- | --- | --- |
| Build | `npm run build` | Shared/runtime packages, web client, server, and CLI builds |
| Shared contract tests | `npm run test:shared` | Zod models, defaults, timeline helpers, and export dimensions |
| Server integration tests | `npm run test:server` | Local API, project/media/recovery flows, leases, FFmpeg jobs, and export |
| CLI integration tests | `npm run test:cli` | CLI executable, JSON output, argument validation, sessions, and API routing |
| All non-browser tests | `npm test` | Shared, server, CLI, and web configuration tests |
| Browser regression | `npm run test:web` | Playwright Chromium coverage for dashboard, editor, autosave, conflicts, shortcuts, and CLI lease handoff |
| Local baseline | `npm run verify` | Build plus `npm test`; browser tests remain separate |
| Full automated baseline | `npm run verify:all` | Build plus all non-browser and browser tests |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` | High-or-higher production dependency advisories |
| Release candidate gate | `npm run release:check` | Prerequisites, full automated baseline, and production audit |

For a full local check in PowerShell:

```powershell
npm.cmd run verify:all
npm.cmd audit --omit=dev --audit-level=high
```

Before preparing a tagged build, run `npm.cmd run release:check` as the combined candidate gate.

GitHub CI runs the equivalent sequence on Linux and Windows: locked install, prerequisite checks, all-workspace build, shared/server/CLI tests, and Playwright Chromium browser tests. Linux also runs the production dependency audit. Failed browser jobs retain screenshots and traces for diagnosis.

## Safety boundaries

- Keep the server on `127.0.0.1` or another loopback address. Do not expose it through a LAN binding, tunnel, reverse proxy, or public interface.
- CutLoc is local-first, but it is not a full process sandbox. Treat media from unknown sources carefully because FFmpeg processes complex native formats.
- The local CLI does not start a hosted AI provider or send project data to an external provider by itself. Do not commit API keys or personal media.
- Export is local and re-encoded. Preview/export parity can vary with codecs, filters, motion, and other effects.
- Keep independent backups of important projects and media. For vulnerability reports, see the [security policy](SECURITY.md).

## Documentation map

- [Changelog](CHANGELOG.md) — release-candidate changes, fixes, and known limitations.
- [Product and development guide](docs/README.md) — architecture, editing model, media/export behavior, local data, testing, and troubleshooting.
- [CLI and AI-agent guide](docs/CLI.md) — command groups, JSON workflows, sessions, leases, export automation, and safety boundaries.
- [Release checklist](docs/RELEASE.md) — candidate gates, version synchronization, onboarding, and publish boundaries.
- [Security policy](SECURITY.md) — reporting guidance and deployment boundaries.

## Contributing

CutLoc v1.1.0 is the current source-distribution development line. Bug reports, focused fixes, interface feedback, documentation improvements, and small test-backed changes are welcome.

Keep changes reviewable by working on a feature branch and opening a pull request:

```powershell
git switch -c feat/short-description
npm.cmd run verify:all
npm.cmd audit --omit=dev --audit-level=high
git add <files>
git commit -m "Describe the change"
git push -u origin feat/short-description
```

In the pull request, explain the user-facing behavior, list validation performed, and include before/after screenshots for visible UI changes. Avoid committing generated output or personal media.

## License

CutLoc is released under the [MIT License](LICENSE), so you can use, modify, and redistribute it freely under that license.
