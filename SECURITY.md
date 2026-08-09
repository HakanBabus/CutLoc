# Security Policy

CutLoc is experimental, local-only software. It is designed to run on the user's own computer and is not a hosted, multi-user, or public upload service.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.0.x` | Yes, for the current experimental line |

## Reporting a vulnerability

Please do not publish exploitable details in a public issue. Use GitHub's private vulnerability reporting when it is available:

[Report a vulnerability](https://github.com/HakanBabus/CutLoc/security/advisories/new)

If private reporting is unavailable, open a minimal public issue without technical details and ask for a private contact channel. Include the affected version or commit, the affected component, reproduction steps, impact, and any suggested mitigation.

There is no guaranteed response or remediation SLA for this experimental project, but reports will be reviewed as time permits.

## Scope and deployment boundary

- Keep the server bound to `127.0.0.1` or another loopback address.
- Do not expose CutLoc through a LAN binding, tunnel, reverse proxy, or public interface.
- Do not upload media or project data that you are not authorized to process.
- FFmpeg processes complex native media formats and is not fully sandboxed by this experimental release.
