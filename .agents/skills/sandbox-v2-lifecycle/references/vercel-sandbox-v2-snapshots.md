# Manual Snapshot API Semantics

Manual snapshots remain useful, but they are not the normal persistent lifecycle for `vercel-openclaw`.

## Manual Snapshot Truth

- `sandbox.snapshot()` is explicit/debug/checkpoint behavior.
- It must be called on a running sandbox.
- It captures filesystem/package state and shuts down the sandbox automatically.
- Do not call `sandbox.stop()` after `sandbox.snapshot()` as part of the same manual snapshot flow.
- `Snapshot.get({ snapshotId })` and `snapshot.delete()` are for explicit/manual snapshot cleanup.
- A snapshot can be used as `source: { type: "snapshot", snapshotId }` for intentional snapshot-backed diagnostics or hot-spares.

## Repo Rules

- Normal `stopSandbox()` must not call `snapshot()`; v2 persistent stop auto-saves.
- `snapshotId` is legacy/manual metadata, not the normal restore gate.
- Snapshot-backed hot-spares require real snapshot provenance.
- Raw SDK debug timing routes may call `snapshot()` only when clearly documented and cleaned up.
