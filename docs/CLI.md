# CutLoc CLI and AI-agent guide

The CutLoc v1.1.0 CLI is a JSON-first client for people, scripts, and tool-using AI agents. It talks to the same loopback Fastify API as the web editor, so project validation, revisions, backups, media rules, and export behavior remain consistent across both interfaces.

The CLI never edits project files directly and does not contact an AI provider.

The v1.1.0 runtime adds a user-level `cutloc` command, automatic server startup, and machine-readable status/doctor checks. Project documents remain on `schemaVersion: 1`; callers must still preserve the latest `revision` and handle conflict responses instead of assuming concurrent writes are safe.

## One-time user setup

After cloning and installing dependencies, register the command once:

```powershell
npm.cmd run setup:user
```

Open a new terminal, then run `cutloc` from any directory. The setup writes a command shim under `%LOCALAPPDATA%\CutLoc\bin`, adds and verifies that directory on the user PATH, stores installation metadata, and prepares `%LOCALAPPDATA%\CutLoc\data`. A legacy checkout-local `data/` directory is copied when the target is empty or contains only empty runtime scaffolding. When both locations contain data, setup copies missing projects and trash entries without replacing conflicts, reports the conflicting paths, and never deletes the source.

## Runtime commands

```powershell
cutloc open
cutloc status --json
cutloc doctor --json
cutloc stop [--force]
cutloc restart [--force]
```

- `open` starts or reuses the shared server and opens the browser editor.
- `status` is read-only: it reports whether CutLoc is running without starting it.
- `doctor` checks the source installation, Node.js, the effective data-directory permissions, FFmpeg/ffprobe, FFmpeg text rendering, PATH, server state, product identity, and CLI/API compatibility.
- `stop` shuts down the managed server without removing projects or settings.
- `restart` stops the current managed server and starts the registered version again.
- Both commands refuse to interrupt queued or running media jobs. Finish or cancel those jobs first. Active editor/agent sessions also block shutdown unless `--force` is explicitly supplied.

Live commands discover the current API through `%LOCALAPPDATA%\CutLoc\runtime\instance.json`. When no live instance exists, they start the server on an available loopback port and wait until it is ready. A managed instance from another CutLoc product version is restarted before a live command proceeds. Detached output is appended to `%LOCALAPPDATA%\CutLoc\logs\server.log`. A command-line `--url` or `CUTLOC_URL` remains an explicit development override and is never auto-started.

Installation and instance records are treated as untrusted runtime state. Incomplete records, relative executable paths, non-loopback URLs, embedded URL credentials, invalid timestamps, and dead process IDs are ignored; a live command then falls back to the registered/source installation path instead of following malformed metadata.

Health discovery requires the endpoint to identify itself as CutLoc and provide both product and API protocol versions. A generic loopback service returning only `{ "ok": true }` is rejected.

The installed command ignores generic `HOST` and `PORT` environment variables, which are commonly set by unrelated tools. Use `CUTLOC_URL` or `--url` for an explicit installed-CLI override. The repository's `npm.cmd run cli` development wrapper still loads `.env` and opts into its `HOST`/`PORT` values.

When no verified server is running, `agent guide` returns `transport.baseUrl: null`; agents should keep using `cutloc` commands and let a live command discover or start the actual dynamic endpoint.

`agent guide` is static and can run without the server.

## Invocation modes

### Development command

```powershell
npm.cmd run cli -- --help
npm.cmd run cli -- projects list
```

This form rebuilds the shared and CLI workspaces before each invocation.

### Installed user/agent command

```powershell
cutloc agent guide
cutloc agent inspect --no-guide --limit 20
```

Use the global command for normal users and agents. `--compact` remains available for one-line JSON.

### Build once

For several commands, build once and call the executable directly:

```powershell
npm.cmd run build:shared
npm.cmd run build:runtime
npm.cmd run build:cli
node apps/cli/dist/index.js --compact agent inspect <project-id>
```

## Output contract

- Successful structured results are JSON on `stdout`.
- Errors are one JSON object on `stderr` and use a non-zero exit code.
- `--compact` writes each result as one line.
- Binary downloads require `--out` or a dedicated download command.
- Prefer `--out` over shell redirection when saving project JSON.

## Recommended AI-agent workflow

1. Discover the static contract with `cutloc agent guide`; this does not require a running server.
2. Optionally inspect runtime state with `cutloc status --json`.
3. Inspect the server and project list with `cutloc agent inspect`; this starts the server when needed.
4. Inspect one project with `cutloc agent inspect <project-id>`.
5. Fetch the latest complete document with `cutloc projects get <id> --out project.json`.
6. Preserve `schemaVersion`, `id`, and `revision`; edit only intended project fields.
7. Apply through `cutloc projects apply <id> --file project.json`.
8. If the server returns `409`, fetch the new revision and reconcile instead of overwriting it.
9. Run `cutloc export preflight` before starting a render.
10. Poll `cutloc jobs get` until the job reaches a terminal state, then download it.

```powershell
cutloc agent inspect <project-id>
cutloc projects get <project-id> --out project.json
cutloc projects apply <project-id> --file project.json
cutloc export preflight <project-id> --file export-options.json
```

## Agent discovery

### `agent guide`

Returns the protocol version, transport rules, recommended workflow, safety rules, editable project areas, invariants, command groups, and examples. It is the preferred capability-discovery endpoint for an AI tool.

```powershell
cutloc agent guide
```

### `agent inspect [project-id]`

Without an ID, returns server health, settings, a compact paginated project page, recent jobs, and the guide. With an ID, it also returns the full selected project, media health, backups, and suggested next commands. `--no-guide` removes the repeated static contract, `--limit` and `--cursor` page the list, and `--full` includes complete project-list entries.

```powershell
cutloc agent inspect
cutloc agent inspect --no-guide --limit 20 --cursor 0
cutloc agent inspect <project-id>
```

## JSON input

Commands accepting JSON support exactly one of:

- `--file <path>`
- `--data <json>`
- `--stdin`

Examples:

```powershell
cutloc settings set --file settings.json
cutloc export preflight <project-id> --data '{"format":"mp4","resolution":"1080p","fps":30,"quality":"standard"}'
Get-Content project.json -Raw | cutloc projects apply <project-id> --stdin
```

## Command reference

### Projects

```text
projects list
projects create [name]
projects get <id> [--out <json>]
projects edit <id> (--file <plan.json> | --data <json> | --stdin) [--dry-run] [--include-project]
projects apply <id> (--file <json> | --data <json> | --stdin)
projects duplicate <id>
projects delete <id>
projects bundle <id> --out <file>
projects import <file>
```

`projects create` accepts `--preset shorts`, or explicit `--aspect`, `--fps`, and `--background` values. `projects edit` applies revision-aware atomic operations including `setName`, `setCanvas`, `addTrack`, `removeTrack`, `addClip`, `updateClip`, `removeClip`, `addMarker`, and `removeMarker`. Use `--dry-run` before mutation. `projects apply` remains available for complete-document replacement. `projects delete` is recoverable through trash until that trash entry is permanently deleted.

### Media

```text
media add <project-id> <file> [--wait] [--include-project]
media add-many <project-id> <files...> [--wait] [--include-project]
media remove <project-id> <asset-id>
media relink <project-id> <asset-id> <file>
media rebuild <project-id> <asset-id>
media health <project-id>
media stock <project-id> <stock-id>
```

Use these commands for binary uploads and relinks. The default upload response is compact. `--wait` waits for the derived-media job and returns `finalRevision`; `--include-project` opts into the complete project payload. Do not put binary data through the generic `api` command.

### Recovery

```text
backups list <project-id>
backups restore <project-id> <file-name>
trash list
trash restore <trash-id>
trash delete <trash-id>
```

Backup restore, project deletion, media removal, and permanent trash deletion change persistent local data. Inspect the target before invoking them.

### Export and jobs

```text
export preflight <project-id> [--file <options.json> | --data <json>]
export start <project-id> [--file <options.json> | --data <json>]
jobs list
jobs get <job-id>
jobs wait <job-id> [--timeout <seconds>] [--interval <seconds>]
jobs watch <job-id> [--timeout <seconds>] [--interval <seconds>]
jobs cancel <job-id>
jobs download <job-id> --out <file>
```

Example `export-options.json`:

```json
{
  "format": "mp4",
  "aspect": "16:9",
  "resolution": "1080p",
  "fps": 30,
  "quality": "standard",
  "audioBitrateKbps": 192,
  "fileName": "final-cut.mp4"
}
```

For a selected range, add:

```json
{
  "range": {
    "start": 12.5,
    "end": 42.0
  }
}
```

`export start` returns an asynchronous job. Prefer `jobs wait` for one terminal JSON result or `jobs watch` for JSONL progress events. Only `queued` or `running` jobs can be cancelled; cancelling a terminal job returns `409`. Download only a completed job. UTF-8 output names are preserved through the download header.

### Preview frame

Render a timeline frame through the same FFmpeg composition path before a full export:

```powershell
cutloc preview frame <project-id> --time 12.5 --out frame.png
```

This is intended for agent visual QA and uses a temporary draft render that is cleaned after the PNG is returned.

### Settings

```text
settings get
settings set (--file <json> | --data <json> | --stdin)
```

The server merges supported settings fields and validates the resulting document.

## Persistent project session

Use a session when several related API operations must share one exclusive project lease:

```powershell
cutloc session <project-id>
```

The first line contains `ready: true`. Send one JSON request per input line:

```json
{"method":"GET","path":"/api/projects/<project-id>"}
{"method":"PATCH","path":"/api/projects/<project-id>","body":{"name":"Agent edit","revision":3}}
```

Each response is one of:

```json
{"ok":true,"result":{}}
{"ok":false,"error":"Description"}
```

A session may access only its locked project, manages its own lease, and does not stream `/api/events`. Closing stdin releases the lease. If the process disappears, the heartbeat expires automatically.

## Low-level API access

```text
api <method> </api/path> [--file <json> | --data <json> | --out <file>]
```

Examples:

```powershell
cutloc api GET /api/health
cutloc api GET /api/jobs
cutloc api PATCH /api/projects/<id> --file patch.json
```

Paths must begin with `/api/`. Mutating project paths automatically acquire the project lease. The generic command rejects SSE streaming and requires `--out` for binary responses.

## Project leases

- A normal mutating command acquires a project-specific lease for the duration of the operation.
- A session refreshes its lease with a heartbeat.
- While the CLI owns a project, the web editor shows the owner and prevents edits to that project.
- Other projects and the dashboard remain available.
- A normal exit releases the lease immediately; a crashed process cannot leave a permanent lock.

## Failure handling

| Condition | Expected response |
| --- | --- |
| Server unavailable | Non-zero exit and JSON error on `stderr` |
| Non-loopback URL | Rejected before the request |
| Invalid command or argument | Non-zero exit and JSON error |
| Stale project revision | HTTP `409`; fetch and reconcile the latest project |
| Project owned by another client | HTTP `423`; wait for or release the lease |
| Too many active jobs | HTTP `429`; retry after existing work finishes |
| Stop/restart while media work is active | Rejected; wait for or cancel the reported jobs |
| Stop/restart while an editor session is active | Rejected unless the deliberate `--force` flag is supplied |
| Terminal job cancellation | HTTP `409`; the completed/failed/cancelled state is preserved |
| Binary endpoint without `--out` | Rejected with an explanatory error |

## Safety checklist for agents

- Never locate or write managed project JSON directly.
- Fetch immediately before editing and preserve the returned revision.
- Validate the project ID, asset ID, job ID, and output path before mutations.
- Use media commands for files and project commands for bundles.
- Treat delete, remove, restore, and cancel as deliberate state changes.
- Do not solve a conflict by discarding a newer server revision.
- Run export preflight and inspect warnings before rendering.
- Confirm terminal job status before downloading or reporting success.

For editor architecture, media behavior, local data, and verification, see the [product and development guide](README.md).
