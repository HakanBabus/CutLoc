<div align="center">
  <img src="apps/web/public/favicon.svg" width="88" height="88" alt="CutLoc logo" />
  <h1>CutLoc</h1>
  <p><strong>A private video editor for creative work.</strong></p>

  [![Experimental](https://img.shields.io/badge/status-experimental-f3b61f)](#project-status)
  [![CutLoc CI](https://github.com/HakanBabus/cutloc/actions/workflows/ci.yml/badge.svg)](https://github.com/HakanBabus/cutloc/actions/workflows/ci.yml)
  [![CodeQL](https://github.com/HakanBabus/cutloc/actions/workflows/codeql.yml/badge.svg)](https://github.com/HakanBabus/cutloc/actions/workflows/codeql.yml)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
</div>

> [!WARNING]
> **CutLoc is experimental software in active development.** Features may be incomplete, behavior may change without migration support, and project files may not remain compatible with future versions. Keep separate backups of important media and projects. Do not use this build as the only copy of production work.

![CutLoc dashboard](assets/screenshots/cutloc-dashboard.jpg)

## What is CutLoc?

CutLoc is a single-user video editor that runs on your own computer. It combines a media library, multi-track timeline, live canvas, clip Inspector, text and caption tools, project recovery, and FFmpeg-based export in one local workspace.

The application is designed around a simple principle: **your working media and project data stay on your device**. The local server binds to `127.0.0.1` by default and is not intended to be exposed as a public or multi-user service.

## Highlights

- **Local-first workspace** — projects, media, proxies, thumbnails, waveforms, backups, and exports are stored locally.
- **Multi-track timeline** — arrange clips across layers, move them between compatible tracks, trim, split, duplicate, ripple-delete, and snap to useful boundaries.
- **Frame-aware editing** — move the playhead, markers, and selected clips using project frame precision.
- **Direct canvas editing** — click a visible text or media object to select the matching timeline clip and Inspector, then position, scale, rotate, flip, or adjust opacity while viewing the result.
- **Zoomable preview** — fit the canvas to the workspace, zoom in with a compact control, and scroll across the enlarged canvas without losing object selection.
- **Motion studio** — apply in, out, or combined animation presets, then tune duration, direction, easing, intensity, and linked timing.
- **Structured Inspector** — edit layout, trim, speed, animation, appearance, filters, keyframes, transitions, audio, text, and subtitles.
- **Media library** — import video, audio, and images; search, filter, sort, preview, and drag items onto the timeline.
- **Creative building blocks** — built-in stock surfaces, shapes inside the Media area, text styles, captions, and SRT/VTT subtitle import.
- **In-app help center** — searchable, topic-based guidance with shortcuts and direct links to the relevant editor panel.
- **Flexible workspace** — resize the tool rail, library, Inspector, preview, and timeline; saved layout settings persist locally.
- **Local export** — render MP4 video or MP3/WAV audio with selectable resolution, frame rate, quality, and range.
- **Safety-oriented project handling** — autosave, revision checks, backups, a recoverable trash area, and partial-output cleanup.

## The editor

![CutLoc editor with media library, canvas, Inspector and timeline](assets/screenshots/cutloc-editor.jpg)

The current editor is organized into four resizable working areas:

1. **Library** for project media, stock content, and shapes.
2. **Canvas** for live preview and direct manipulation.
3. **Inspector** for the selected clip's editable properties.
4. **Timeline** for layered, frame-aware editing.

## Project status

CutLoc is currently an **experimental v0.0.1 project**. It is suitable for local testing, interface exploration, and continued development—not yet for production-critical editing.

| Area | Current state |
| --- | --- |
| Local project storage | Available |
| Media import and derived previews | Available |
| Layered timeline editing | Available, still evolving |
| Canvas and Inspector controls | Available, still evolving |
| MP4, MP3, and WAV export | Available through local FFmpeg |
| English and Turkish UI | Dictionary-based coverage for the editor surfaces; legacy labels may still be incomplete |
| AI Chat | Visible as a disabled future placeholder |
| Hosted or collaborative editing | Not supported |

## Technology

- **React 19** and **Vite** for the editor interface
- **TypeScript** across the client, server, and shared contracts
- **Zustand** and **Immer** for editor state and immutable project updates
- **Fastify** for the loopback-only local API
- **Zod** for shared runtime validation
- **FFmpeg / ffprobe** for probing, proxies, thumbnails, waveforms, and export
- **Node.js 24.x** in continuous integration

## Getting started

### Requirements

- Windows 10 or 11 is the current primary target.
- Node.js 24.x and npm are recommended.
- A Chromium-based browser is recommended for the current web interface.

### Clone and install

```powershell
git clone https://github.com/HakanBabus/cutloc.git
cd cutloc
npm ci
```

### Run in development mode

```powershell
npm run dev
```

Then open:

```text
http://127.0.0.1:5173
```

Vite serves the interface on port `5173` and proxies local API requests to the Fastify server on port `4173`.

### Run a production-style local build

```powershell
npm start
```

Then open:

```text
http://127.0.0.1:4173
```

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the web and local API development processes |
| `npm run build` | Build the shared package, web client, and server |
| `npm test` | Run shared and server tests |
| `npm run verify` | Build everything and run the complete automated test suite |
| `npm start` | Build and start the production-style local server |

## Local data

By default, runtime files are written to the ignored `data/` directory:

```text
data/
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

You can change the location with `DATA_DIR` in a local `.env` file. Never commit `.env`, project media, exports, or the `data/` directory.

## Repository layout

```text
cutloc/
├── apps/
│   ├── web/       # React and Vite editor
│   └── server/    # Fastify API and FFmpeg workflow
├── packages/
│   └── shared/    # Shared schemas, types, and editing helpers
├── assets/
│   └── screenshots/
└── package.json
```

## Security and privacy

- The server is intended to remain bound to `127.0.0.1`.
- Do not expose the server through a public interface, tunnel, or LAN binding.
- Do not commit API keys, personal media, local projects, or exported files.
- Treat media from unknown sources carefully; FFmpeg processes complex native formats and the current experimental build does not provide a full process sandbox.
- GitHub Actions run build, test, dependency-audit, and CodeQL checks for repository changes.

## Contributing

CutLoc is still taking shape. Bug reports, focused fixes, interface feedback, and small test-backed improvements are welcome.

Before submitting a change, run:

```powershell
npm run verify
npm audit --omit=dev --audit-level=high
```

Keep pull requests narrow, explain the user-facing behavior being changed, and avoid committing generated output or personal media.

## License

No open-source license has been selected yet. Until a license is added, the repository remains **all rights reserved** by default.
