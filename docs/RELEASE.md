# CutLoc release checklist

This checklist prepares a release candidate; it does not publish, tag, or change the product version by itself.

## Candidate gate

1. Start from the intended clean commit and confirm the working tree contains only reviewed release changes.
2. Install exactly the locked dependency graph with Node.js 24.x and npm 11.x.
3. Run the combined local gate:

   ```powershell
   npm.cmd ci
   npm.cmd run release:check
   ```

4. Start a production-style local server with a disposable `DATA_DIR`. Confirm the dashboard, `/api/health`, project creation, CLI inspection, and clean shutdown.
5. Test at least one representative video import and MP4 export on Windows using the bundled FFmpeg binaries.
6. Confirm GitHub CI passes from the exact candidate commit.

## Version and documentation

- Update the root and workspace package versions together.
- Update the version badge, project-status text, English README, Turkish README, product guide, and security support table.
- Record user-visible changes, known limitations, supported Node/npm versions, project schema compatibility, and upgrade notes.
- Do not call a build stable while known data-loss, silent-overwrite, startup, or export-corruption defects remain open.

## Packaging and onboarding

- Keep `npm.cmd run doctor` as the first troubleshooting command after installation.
- Verify a fresh clone on a Windows machine without global FFmpeg.
- Keep `.env.example` limited to settings the released product actually uses.
- For a later installer, preserve the same loopback-only server, user-selected data directory, visible logs, and reversible uninstall/data-retention choices.

## Publish boundary

Tagging, pushing, creating a GitHub release, and uploading artifacts are separate explicit actions. Run this checklist first and publish only after the candidate commit and release notes are approved.
