# Luna Max Task Packet

## Outcome

Inspect and improve the current WebEditor/Local Cut video editor in this checkout. Implement and verify a polished user-facing overhaul for the requested editor surfaces:

1. Make animation controls understandable from end to end. Replace hard-to-use direct/dropdown-style animation selection with a visually strong preview-based selection experience. You may add sub-tabs under the animation area if that improves discoverability.
2. Ensure text objects can use the same appropriate animation/fade capabilities as other supported objects, and disable any unwanted default fade behavior. Existing text objects must not silently receive a fade unless the user explicitly chooses it.
3. Modernize the preview zoom control so it no longer feels like an old slider, while preserving accurate zoom behavior and useful fit/reset affordances.
4. Expand the stock shape library substantially beyond the current small/basic set, with a coherent visual catalog and working insertion behavior.
5. Rebuild the left-side text insertion tab from the ground up: make adding text fast, clear, attractive, and useful for common title/lower-third/quote/caption use cases. Preserve the editor's visual quality; do not trade appearance for feature count.

## Scope and constraints

- Workspace: `C:\Users\Hakan\Documents\WebEditor`
- This is an implementation task; use `workspace-write` and modify the existing project in place.
- Inspect the current source, shared contracts, tests, and the live editor before deciding implementation details.
- Preserve unrelated user work. The pre-existing modification to `apps/server/package.json` is user-owned and must remain intact.
- Do not use destructive git operations, rewrite history, or alter production/external systems.
- Reuse the existing React/Vite architecture and current visual language where appropriate; avoid a superficial mockup disconnected from real state and insertion flows.
- Keep export/preview data contracts compatible unless a narrowly scoped, validated change is required.
- Ensure animation choices degrade safely for unsupported objects and malformed/legacy project state.
- Do not enable default fade as a hidden side effect of adding text or other objects.

## Acceptance criteria

- A user can understand and preview animation choices before applying one, with clear grouping, labels, timing/direction affordances, and selected-state feedback.
- Text insertion and text objects can access the intended animation/fade workflow; a newly inserted text object has no implicit fade.
- Preview zoom looks modern and offers precise, discoverable controls (including a sensible reset/fit path) without breaking existing zoom behavior.
- The stock shape catalog contains a materially larger, navigable set and each new shape inserts through the existing editor flow.
- The left text tab is visibly redesigned, supports useful presets or quick starts, and remains coherent with the rest of the editor.
- Existing editor behaviors outside the requested surfaces continue to work.
- Run the smallest relevant deterministic checks (typecheck/build/tests/lint if available) and inspect the actual UI in a browser or equivalent rendered output. Fix material issues found during verification.

## Required worker reporting

Report only useful artifacts, not private chain-of-thought: observed baseline, key design/architecture decision and rejected alternatives, changed files, validation commands/results, remaining risks, and any Luna Max/launcher issue encountered.

## Re-entry evidence from the previous attempt

- The previous pinned worker reached source inspection and identified the real gaps, but its patch was rejected because its runtime banner reported `sandbox: read-only` even though the launcher dry-run requested `workspace-write`.
- Direct PowerShell execution of `codex.exe` also returned Windows `Erişim engellendi`, while `cmd /d /c codex --version` succeeds. The current retry is being launched through `cmd` so the requested `workspace-write` policy can be observed in the worker banner.
- Do not treat this evidence as permission to use a broader sandbox or to launch another worker. Preserve the exact scope and constraints above.
