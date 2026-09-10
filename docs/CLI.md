# CutLoc CLI and AI-agent guide

The CutLoc CLI is a JSON-first client for people, scripts, and tool-using AI agents. It talks to the same loopback Fastify API as the web editor, so project validation, revisions, backups, media rules, and export behavior remain consistent across both interfaces.

The CLI never edits project files directly and does not contact an AI provider.

## Start the server

Run the local API before commands that need live data:

```powershell
npm.cmd run dev:server
```

The default URL is `http://127.0.0.1:4173`. Override it with `--url` or `CUTLOC_URL`. Only HTTP(S) loopback hosts are accepted.

`agent guide` is static and can run without the server.

## Invocation modes

### Development command

```powershell
npm.cmd run cli -- --help
npm.cmd run cli -- projects list
```

This form rebuilds the shared and CLI workspaces before each invocation.

### AI-agent command

```powershell
npm.cmd run --silent cli:agent -- agent guide
npm.cmd run --silent cli:agent -- agent inspect
```

`cli:agent` suppresses npm lifecycle output and enables compact one-line JSON.

### Build once

For several commands, build once and call the executable directly:

```powershell
npm.cmd run build:shared
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

1. Discover the contract with `agent guide`.
2. Inspect the server and project list with `agent inspect`.
3. Inspect one project with `agent inspect <project-id>`.
4. Fetch the latest complete document with `projects get <id> --out project.json`.
5. Preserve `schemaVersion`, `id`, and `revision`; edit only intended project fields.
6. Apply through `projects apply <id> --file project.json`.
7. If the server returns `409`, fetch the new revision and reconcile instead of overwriting it.
8. Run `export preflight` before starting a render.
9. Poll `jobs get` until the job reaches a terminal state, then download it.

```powershell
npm.cmd run --silent cli:agent -- agent inspect <project-id>
npm.cmd run --silent cli:agent -- projects get <project-id> --out project.json
npm.cmd run --silent cli:agent -- projects apply <project-id> --file project.json
npm.cmd run --silent cli:agent -- export preflight <project-id> --file export-options.json
```

## Agent discovery

### `agent guide`

Returns the protocol version, transport rules, recommended workflow, safety rules, editable project areas, invariants, command groups, and examples. It is the preferred capability-discovery endpoint for an AI tool.

```powershell
npm.cmd run --silent cli:agent -- agent guide
```

### `agent inspect [project-id]`

Without an ID, returns server health, settings, projects, jobs, and the guide. With an ID, it also returns the full selected project, media health, backups, and suggested next commands.

```powershell
npm.cmd run --silent cli:agent -- agent inspect
npm.cmd run --silent cli:agent -- agent inspect <project-id>
```

## JSON input

Commands accepting JSON support exactly one of:

- `--file <path>`
- `--data <json>`
- `--stdin`

Examples:

```powershell
npm.cmd run cli -- settings set --file settings.json
npm.cmd run cli -- export preflight <project-id> --data '{"format":"mp4","resolution":"1080p","fps":30,"quality":"standard"}'
Get-Content project.json -Raw | npm.cmd run cli -- projects apply <project-id> --stdin
```

## Command reference

### Projects

```text
projects list
projects create [name]
projects get <id> [--out <json>]
projects apply <id> (--file <json> | --data <json> | --stdin)
projects duplicate <id>
projects delete <id>
projects bundle <id> --out <file>
projects import <file>
```

`projects apply` validates the complete project document. `projects delete` is recoverable through trash until that trash entry is permanently deleted.

### Media

```text
media add <project-id> <file>
media remove <project-id> <asset-id>
media relink <project-id> <asset-id> <file>
media rebuild <project-id> <asset-id>
media health <project-id>
media stock <project-id> <stock-id>
```

Use these commands for binary uploads and relinks. Do not put binary data through the generic `api` command.

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

`export start` returns an asynchronous job. Use `jobs get` until `status` is `completed`, `failed`, or `cancelled`. Only `queued` or `running` jobs can be cancelled; cancelling a terminal job returns `409`. Download only a completed job. UTF-8 output names are preserved through the download header.

### Settings

```text
settings get
settings set (--file <json> | --data <json> | --stdin)
```

The server merges supported settings fields and validates the resulting document.

## Persistent project session

Use a session when several related API operations must share one exclusive project lease:

```powershell
npm.cmd run cli -- session <project-id>
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
npm.cmd run cli -- api GET /api/health
npm.cmd run cli -- api GET /api/jobs
npm.cmd run cli -- api PATCH /api/projects/<id> --file patch.json
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
| Terminal job cancellation | HTTP `409`; the completed/failed/cancelled state is preserved |
| Binary endpoint without `--out` | Rejected with an explanatory error |

## Safety checklist for agents

- Never write `data/projects/.../project.json` directly.
- Fetch immediately before editing and preserve the returned revision.
- Validate the project ID, asset ID, job ID, and output path before mutations.
- Use media commands for files and project commands for bundles.
- Treat delete, remove, restore, and cancel as deliberate state changes.
- Do not solve a conflict by discarding a newer server revision.
- Run export preflight and inspect warnings before rendering.
- Confirm terminal job status before downloading or reporting success.

For editor architecture, media behavior, local data, and verification, see the [product and development guide](README.md).
