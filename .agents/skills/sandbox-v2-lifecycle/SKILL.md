---
name: sandbox-v2-lifecycle
description: "Vercel Sandbox v2 lifecycle expertise for vercel-openclaw: named persistent OpenClaw sandbox create/resume/stop/delete, persistent auto-save truth, manual snapshot diagnostics, short-lived worker sandboxes, hot spares, and SDK v2 semantics."
---

# Sandbox v2 Lifecycle

Use this skill for `vercel-openclaw` sandbox lifecycle, restore, stop, reset, hot-spare, worker sandbox, and debug timing work.

## Source Of Truth

Official Vercel Sandbox v2 docs are authoritative. Repo docs or agent guidance that assumes v1/manual snapshot restore is stale unless already updated.

Load references only as needed:

- `references/vercel-sandbox-v2-persistent.md` — persistent sandbox auto-save/resume/name/session model.
- `references/vercel-sandbox-v2-sdk.md` — SDK calls, resume flags, delete, command behavior, and network policy notes.
- `references/vercel-sandbox-v2-snapshots.md` — manual Snapshot API semantics.
- `references/vercel-openclaw-lifecycle-map.md` — repo-specific invariants and owner files.

## Core Model

- Main OpenClaw runtime is one named persistent sandbox.
- Persistent `stop()` auto-saves filesystem state; no manual `snapshot()` is needed for normal stop.
- Normal wake resumes by name with `Sandbox.get({ name, resume: true })` through the repo controller.
- `resume` defaults false; use `resume:false` for observation/status reconciliation.
- Commands may auto-resume stopped persistent sandboxes; `stop()` and `update()` do not.
- Manual `snapshot()` is explicit/debug/checkpoint only. It shuts the sandbox down; do not call `stop()` afterward.
- `delete()` permanently removes the persistent sandbox and its sessions/snapshots.
- Worker/debug sandboxes are short-lived; pass `persistent:false`.

## Repo Invariants

- Preserve one persistent OpenClaw sandbox, Redis metadata, channel wake/restore, and short-lived workers.
- Keep SDK access behind `src/server/sandbox/controller.ts` except documented raw SDK debug routes.
- Distinguish host metadata status, SDK status/session, gateway readiness, persistent auto-saved state, and manual Snapshot APIs.
- Do not use manual `snapshotId` as the normal restore gate.
- Preserve `resume:false` during snapshotting/stopped observation.
- Keep lifecycle locks and fail-closed firewall behavior.

## Workflow

1. Read `lat.md/sandbox-lifecycle.md`, `docs/lifecycle-and-restore.md`, and relevant references from this skill.
2. Inspect `src/server/sandbox/lifecycle.ts`, `controller.ts`, `restore-attestation.ts`, `hot-spare.ts`, and worker sandbox code.
3. Classify whether the change affects persistent resume, manual snapshots, reset/delete, workers, or debug diagnostics.
4. Patch the smallest surface that fixes the v2 truth model.
5. Add or adjust targeted tests before broad verification.

## Verification

Run the narrowest covering test first, then broader gates for lifecycle changes:

```bash
node --import tsx --test src/server/sandbox/restore-attestation.test.ts
pnpm run test:lifecycle
pnpm run typecheck
pnpm run lint
lat check
```

When touching launch verification or preflight, also run `pnpm run verify:observability-pass`.
