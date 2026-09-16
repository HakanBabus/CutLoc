# Security Policy

CutLoc is local-only software. It is designed to run on the user's own computer and is not a hosted, multi-user, or public upload service.

## Supported versions

| Version | Supported |
| --- | --- |
| `1.1.x` | Yes |
| `1.0.x` | Yes |
| Pre-1.0 beta snapshots | No guaranteed fixes |

## Reporting a vulnerability

Please do not publish exploitable details in a public issue. Use GitHub's private vulnerability reporting when it is available:

[Report a vulnerability](https://github.com/HakanBabus/CutLoc/security/advisories/new)

If private reporting is unavailable, open a minimal public issue without technical details and ask for a private contact channel. Include the affected version or commit, the affected component, reproduction steps, impact, and any suggested mitigation.

There is no guaranteed response or remediation SLA, but reports affecting the supported release will be reviewed as time permits.

## Scope and deployment boundary

- Keep the server bound to `127.0.0.1` or another loopback address.
- Project IDs and managed media paths are validated at the API boundary; do not bypass the API to edit project storage.
- Local API traffic is rate-limited, with a tighter budget for FFmpeg-backed preview rendering.
- Do not expose CutLoc through a LAN binding, tunnel, reverse proxy, or public interface.
- Do not upload media or project data that you are not authorized to process.
- FFmpeg processes complex native media formats and is not fully sandboxed by this local release.
