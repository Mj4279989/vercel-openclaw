---
name: sandbox-lifecycle-debug
description: "Sandbox lifecycle debugging for vercel-openclaw: create, resume, stop, snapshotting, reset, stale-running reconciliation, persistent Sandbox v2 behavior, hot spares, and lifecycle locks. Use when sandbox state transitions, status polling, stop/resume, reset, or lifecycle recovery is wrong."
---

# Sandbox Lifecycle Debug

Use this skill when the sandbox state machine is the primary suspect.

For Sandbox v2 truth-model work, also load `sandbox-v2-lifecycle`. Official Vercel Sandbox v2 docs override older repo guidance that treats manual snapshots as the normal restore source.

## Start Here

Read `lat.md/sandbox-lifecycle.md` sections `Status State Machine`, `Triggers -- What Causes State Transitions`, and the specific trigger involved. Run `lat locate "Sandbox Lifecycle"` or `lat search "sandbox lifecycle <symptom>"` when unsure.

Collect before edits:

- `GET /api/status` and any UI state that triggered the action.
- `GET /api/admin/sandbox-diag`.
- `GET /api/admin/logs` filtered for `sandbox.`, `gateway.`, `watchdog.`, `proxy.`.
- Local `git rev-parse HEAD`, remote `git ls-remote origin main`, and live deployment proof.

## Split The State

Report these separately:

- metadata status in `SingleMeta.status`
- Vercel Sandbox SDK status
- gateway readiness on port 3000
- persistent auto-saved state availability
- manual snapshot/checkpoint availability when relevant
- lifecycle lock and start lock state when visible
- UI polling status

Do not use `running` as shorthand for gateway-ready or user-ready.

## Common Paths

- Admin ensure: `/api/admin/ensure` -> `ensureSandboxRunning()` / `ensureSandboxReady()`.
- Gateway request: auth -> `ensureSandboxRunning()` -> token refresh -> `touchRunningSandbox()` -> proxy.
- Stop/auto-save: `stopSandbox()` -> cleanup -> cron persistence -> `sandbox.stop({ blocking: false })` -> `snapshotting` host metadata while v2 persists state.
- Status polling: `GET /api/status` -> stale running or snapshotting reconciliation.
- Reset: `resetSandbox()` destroys active sandbox and snapshots, clears cron and token metadata.

## Sandbox v2 Rules

- Main OpenClaw sandbox is one named persistent sandbox.
- Normal resume uses the persistent name and auto-saved state, not manual `snapshotId`.
- Observation of stopped/snapshotting state must use `resume:false`.
- Manual `snapshot()` is explicit/debug/checkpoint only and shuts the sandbox down.
- Worker/debug sandboxes are short-lived and must use `persistent:false`.

## Fix Boundaries

- Primary: `src/server/sandbox/lifecycle.ts`, `src/server/sandbox/controller.ts`.
- Routes: `src/app/api/admin/{ensure,stop,snapshot,reset,status}/**` and `src/app/api/status/route.ts`.
- Tests: lifecycle and harness tests under `src/server/sandbox/**.test.ts` and `src/test-utils/harness`.
- Docs: `lat.md/sandbox-lifecycle.md`, `docs/lifecycle-and-restore.md`.

## Verification

Use the narrowest command that covers the path, then run the repo verifier when the change has broad lifecycle impact:

```bash
node scripts/verify.mjs --steps=test,typecheck
lat check
```

For live lifecycle incidents, include before/after `/api/status`, `/api/admin/sandbox-diag`, and relevant log events.
