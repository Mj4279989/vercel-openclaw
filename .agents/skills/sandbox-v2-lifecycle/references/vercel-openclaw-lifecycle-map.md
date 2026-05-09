# vercel-openclaw Lifecycle Map

Repo-specific guide for applying Sandbox v2 semantics without rewriting the control plane.

## Owner Files

- `src/server/sandbox/controller.ts` — SDK boundary and test override.
- `src/server/sandbox/lifecycle.ts` — create/resume/stop/reset/prepare logic.
- `src/server/sandbox/restore-attestation.ts` — persistent saved-state readiness decision.
- `src/server/sandbox/hot-spare.ts` — feature-flagged spare sandbox state.
- `src/server/sandbox/snapshot-delete.ts` — manual snapshot cleanup.
- `src/server/worker-sandboxes/**` — short-lived worker sandboxes.
- `src/app/api/debug/sandbox-timing/route.ts` — raw SDK diagnostic timing.

## Local Truth Names

- `SingleMeta.sandboxId` is the local alias for the v2 persistent sandbox name/handle.
- `persistedStateDynamicConfigHash` and `persistedStateAssetSha256` describe the last verified v2 persistent auto-save.
- `snapshotId` and `snapshotHistory` are manual/debug/legacy snapshot metadata.
- `restorePreparedStatus: "ready"` means the next persistent resume target has verified config/assets state.

## Stop/Resume Sequence

1. Running sandbox has current runtime config/assets.
2. Prepare verifies gateway readiness and calls `stopSandbox()`.
3. v2 persistent stop auto-saves filesystem state.
4. Metadata stamps persisted-state hashes and `restorePreparedStatus="ready"`.
5. Wake uses `Sandbox.get({ name, resume:true })` and command-based readiness.
6. Runtime config/assets may be reconciled after resume; persisted-state truth is updated only after the next verified prepare/stop.
