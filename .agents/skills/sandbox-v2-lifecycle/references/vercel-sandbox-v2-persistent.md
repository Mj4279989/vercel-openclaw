# Vercel Sandbox v2 Persistent Model

Official docs are the authority for persistent sandbox behavior. Use this reference when lifecycle or restore guidance conflicts with older snapshot-oriented repo text.

## Truth Model

- Persistent sandboxes are identified by name. In `vercel-openclaw`, the stable name is derived as `oc-<instance-id>` and is stored locally in `SingleMeta.sandboxId` for compatibility.
- The main OpenClaw sandbox should be created with `persistent: true` explicitly, even when the SDK default is persistent.
- `sandbox.stop()` ends the current session and auto-saves filesystem state for persistent sandboxes.
- Normal persistent resume is `Sandbox.get({ name, resume: true })`, surfaced through this repo as `get({ sandboxId: name, resume: true })`.
- `resume` defaults false, so observation paths must pass `resume:false` when checking stopped/snapshotting state.
- Commands can auto-resume a stopped persistent sandbox; `stop()` and `update()` do not auto-resume.
- `sandbox.delete()` permanently removes the named sandbox and its sessions/snapshots.

## Repo Implications

- Do not require a manual `snapshotId` for normal persistent resume.
- Restore preparedness means the last verified persistent auto-saved state has fresh config/assets hashes.
- Manual snapshot fields may exist for explicit/debug/checkpoint flows and legacy metadata hydration.
- State names such as `snapshotting` are host metadata labels for stop/auto-save in progress, not proof that `sandbox.snapshot()` ran.
