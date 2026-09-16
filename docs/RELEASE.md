# CutLoc v1.0.0 release checklist

This checklist defines the v1.0.0 source-release gate and the repeatable process for later releases. Publishing remains a separate, explicit action after the candidate commit passes both local and GitHub checks.

## v1.0.0 release contract

- Release tag: `v1.0.0`
- Package versions: `1.0.0` in the root and every workspace
- Project compatibility: `schemaVersion: 1`; no project migration is required
- Runtime baseline: Node.js 24.x and npm 11.x
- Distribution: GitHub source archives; no installer or prebuilt desktop binary is included
- Support boundary: single-user and loopback-only, with local FFmpeg processing

## Candidate gate

1. Start from the intended clean commit and confirm the working tree contains only reviewed release changes.
2. Install exactly the locked dependency graph with Node.js 24.x and npm 11.x.
3. Run the combined local gate:

   ```powershell
   npm.cmd ci
   npm.cmd run release:check
   ```

4. Run `npm.cmd run smoke:release` to start a production-style server with a disposable `DATA_DIR`, create a project through the CLI, import a generated video, export MP4, download it, and cleanly remove the fixture.
5. Confirm the smoke uses the bundled FFmpeg binaries on Windows; Linux may select a full system build when the bundled binary lacks required filters.
6. Confirm GitHub CI passes from the exact candidate commit.
7. Run `git diff --check` and confirm no generated media, runtime data, credentials, or `AGENTS.md` file is staged.

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

After the user authorizes publication:

1. Commit the reviewed product fixes separately from version/documentation changes.
2. Push the candidate commit to `main` and wait for CutLoc CI and CodeQL on that exact SHA.
3. Create and push an annotated `v1.0.0` tag at the verified candidate commit.
4. Create the GitHub Release from that tag, using the matching changelog entry as the release notes.
5. Read back the remote tag and release URL to confirm publication.

Do not move or recreate an existing release tag. A correction after publication requires a new version.
