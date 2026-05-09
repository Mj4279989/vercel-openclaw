# Vercel Sandbox API Audit

This report inventories how `vercel-openclaw` uses `@vercel/sandbox` and records the main risks found by a `$oracle-packx` review of the sandbox controller, lifecycle, worker sandbox, firewall, diagnostic, and documentation code paths.

## Scope

The Oracle pass reviewed a packx bundle focused on:

- `src/server/sandbox/**`
- `src/server/worker-sandboxes/**`
- `src/app/api/internal/worker-sandboxes/**`
- `src/app/api/admin/sandbox-diag/route.ts`
- `src/app/api/debug/{sandbox-timing,sdk-import-timing}/route.ts`
- `src/server/firewall/{policy,state}.ts`
- `src/test-utils/fake-sandbox-controller.ts`
- `docs/{architecture,lifecycle-and-restore}.md`
- `package.json`

The installed dependency is `@vercel/sandbox@^2.0.0-beta`, so compatibility risk should be treated as active for status names, error shapes, network policy formats, snapshot behavior, and command result shapes.

## Executive Summary

## Resolution: Sandbox v2 Truth Model

Official Vercel Sandbox v2 documentation is now the source of truth for lifecycle semantics. The normal OpenClaw lifecycle uses one named persistent sandbox: `stop()` auto-saves persistent state, `Sandbox.get({ name, resume: true })` is the normal wake path, and manual `snapshot()` is explicit/debug checkpoint behavior only. Older v1-style guidance that makes `snapshotId` the required normal restore authority is deprecated for this app.

`vercel-openclaw` mostly keeps Vercel Sandbox SDK access behind `src/server/sandbox/controller.ts`, which is the right boundary for a beta SDK. The app manages one persistent OpenClaw sandbox, plus short-lived worker sandboxes for bounded job execution.

The main sandbox lifecycle is:

1. Derive a stable persistent sandbox name.
2. Try `Sandbox.get({ name, resume: true })` through the local controller.
3. Reject failed, aborted, stopped, or otherwise unhealthy handles.
4. Fall back to `Sandbox.create({ name, persistent: true, ports, timeout, resources, env })`.
5. Bootstrap or fast-restore OpenClaw.
6. Apply firewall network policy.
7. Resolve public port URLs with `sandbox.domain(port)` and cache them in metadata.
8. Stop with `sandbox.stop({ blocking: false })`, relying on Vercel Sandbox v2 persistent auto-save behavior.
9. Reconcile snapshotting state with `Sandbox.get({ resume: false })` so status polling does not accidentally wake the sandbox.

The strongest patterns to preserve are the narrow controller interface, the fake controller for tests, metadata parking before non-blocking stop, `resume: false` during snapshot reconciliation, lifecycle lock renewal, and fail-closed firewall enforcement.

The original highest-priority findings were documentation and lifecycle-truth mismatches. The current source of truth is persistent saved state, tracked by `persistedState*` metadata; legacy `snapshotId` fields remain for manual snapshot/checkpoint compatibility. Credential-brokering docs now describe the current bootstrap-env exception instead of claiming the token can never exist inside the VM.

## API Inventory

| SDK/API Surface | Local Use | Operational Purpose | Notes |
| --- | --- | --- | --- |
| `@vercel/sandbox` package | `package.json` | Provides the beta Sandbox SDK. | Current package range is `^2.0.0-beta`; behavior drift should be expected. |
| `Sandbox.create(...)` | `realController.create()`, worker executor, debug timing route | Creates the persistent OpenClaw sandbox, short-lived worker sandboxes, and diagnostic sandboxes. | Main lifecycle creates with `persistent: true`; worker sandboxes use bounded timeout/resources. |
| `Sandbox.get(...)` | `realController.get()`, lifecycle, diagnostics, domain resolution, reset | Looks up, resumes, or observes existing sandboxes. | Snapshot reconciliation must use `resume: false`; normal wake uses `resume: true`. |
| `sandbox.status` | `wrapSandbox()`, lifecycle reconciliation | Decides whether a handle is healthy, stopped, snapshotting, or failed. | Status names are beta-SDK-sensitive and should be contract-tested. |
| `sandbox.timeout` | `touchRunningSandbox()`, timeout helpers | Computes remaining runtime before extending sandbox timeout. | Missing timeout normalizes to `0` in the wrapper. |
| `sandbox.runCommand(...)` | Bootstrap, fast restore, readiness probes, diagnostics, worker execution | Runs shell commands and scripts inside the sandbox. | Generic object-form wrapper forwards `cmd`, `args`, `env`, `signal`, `stdout`, and `stderr`. |
| `CommandResult.exitCode` / `output(...)` | Lifecycle and worker execution | Standardizes command status and stdout/stderr reads. | Worker execution should add explicit abort signals instead of relying only on route/sandbox timeouts. |
| `sandbox.writeFiles(...)` | Restore/config sync, worker input upload | Writes OpenClaw config/assets and worker input files. | Worker file writes are constrained to `/workspace`. |
| `sandbox.readFileToBuffer(...)` | Cron capture, asset manifest reads, worker output capture | Reads files from the sandbox. | The wrapper returns `null` on any read error, so missing files and read failures are indistinguishable. |
| `sandbox.domain(port)` | `getSandboxDomain()` | Resolves public sandbox port URLs for gateway/native-handler forwarding. | There is no `getDomain` SDK method in the local wrapper; the instance method is `domain(port)`. |
| `sandbox.snapshot()` | Controller wrapper, debug timing route | Manual snapshot support in diagnostics and legacy/manual paths. | Normal lifecycle intentionally does not call it; stop relies on persistent auto-save. |
| `sandbox.stop({ blocking })` | `stopSandbox()`, reset cleanup, worker cleanup, debug cleanup | Stops persistent or short-lived sandboxes. | Main lifecycle uses `blocking: false`; cleanup paths generally use `blocking: true`. |
| `sandbox.delete()` | Reset and unhealthy-handle cleanup | Destroys active or bad sandbox handles. | Reset best-effort stops before delete. |
| `sandbox.extendTimeout(duration)` | `touchRunningSandbox()` | Keeps a running sandbox alive during active use. | Extension amount is computed from observed remaining timeout. |
| `sandbox.update({ networkPolicy })` | `updateNetworkPolicy()`, firewall state | Applies egress policy and AI Gateway transform rules. | Wrapper returns the requested policy rather than the SDK response. |
| `NetworkPolicy` object/string forms | `src/server/firewall/policy.ts` | Represents disabled, learning, enforcing, and AI Gateway transform policies. | Object form with `"*": []` plus transforms should be verified against the installed SDK. |
| `Snapshot.get(...).delete()` | `src/server/sandbox/snapshot-delete.ts` | Deletes tracked snapshots during reset/manual cleanup. | `APIError.response.status === 404` is handled only in this snapshot-delete helper. |
| `APIError` | `snapshot-delete.ts` | Classifies snapshot-not-found during deletion. | Other lifecycle paths still use string matching for some gone-sandbox cases. |
| `AbortSignal.timeout(...)` | Diagnostics and selected probes | Bounds shell probes and request-scoped diagnostics. | Worker execution does not currently pass a command signal. |
| Raw SDK debug import | `/api/debug/sdk-import-timing` | Measures dynamic import timing for `@vercel/sandbox`. | Intentional diagnostic exception to the controller boundary. |
| Raw SDK debug sandbox timing | `/api/debug/sandbox-timing` | Measures create, command, snapshot, and stop timings from a snapshot source. | Bypasses normal controller/resource validation and only stops the diagnostic sandbox. |
| Detached commands | `runDetachedCommand()`, `getCommand().kill()` wrapper | Exposes detached command support. | No production use was evident in the reviewed bundle; add tests or remove until needed. |

## Lifecycle Map

### Persistent Sandbox

The persistent sandbox is the user-visible OpenClaw runtime. `ensureSandboxRunning()` uses metadata to decide whether to return immediately, schedule lifecycle work, resume an existing sandbox, or create from scratch.

Lifecycle work takes the start lock and lifecycle lock with auto-renewal. The code then derives the stable `oc-...` sandbox name, tries `get({ resume: true })`, rejects unhealthy handles, and falls back to `create({ persistent: true, ports, timeout, resources, env, networkPolicy })`. If create hits a name conflict, it falls back to `get({ resume: true })` again.

After a handle exists, the app runs a marker command. That command both detects whether the sandbox has already been bootstrapped and acts as the implicit resume trigger for stopped persistent sandboxes. Resumed sandboxes run asset/config sync, fast restore, gateway readiness checks, and firewall sync. Fresh sandboxes run full OpenClaw bootstrap and then firewall sync before metadata is marked `running`.

### Public Port URLs

`getSandboxDomain()` returns cached metadata when available. On cache miss it retrieves the sandbox handle and calls `sandbox.domain(port)`, then stores the resolved URL in metadata. Fast-path channel forwarding can invalidate stale cached URLs when Vercel returns a sandbox-not-listening response.

### Stop and Snapshotting

`stopSandbox()` persists cron state, clears cached port URLs, marks readiness as unsafe, parks metadata in `snapshotting`, and then calls `sandbox.stop({ blocking: false })`. The code and docs rely on Vercel Sandbox v2 persistent sandboxes auto-saving on stop; normal lifecycle does not call `sandbox.snapshot()`.

`reconcileSnapshottingStatus()` must observe platform state with `resume: false`. Without that flag, status polling can accidentally wake the sandbox being observed. If the platform remains in a transitional state past the stale-operation guardrail, the app force-transitions metadata to stopped as an availability fallback, not as proof that Vercel finished snapshotting.

### Reset and Snapshot Deletion

Reset collects tracked snapshot IDs, best-effort stops and deletes the current sandbox, then deletes tracked snapshots with `Snapshot.get({ snapshotId }).delete()`. Snapshot 404s are tolerated; other deletion failures keep failed snapshot history in metadata and return an error.

### Worker Sandboxes

Worker routes are internal bearer-authenticated execution endpoints. They create short-lived sandboxes with clamped timeouts/resources, write requested files under `/workspace`, run the requested command, capture requested output files, and stop the sandbox with `blocking: true`.

When `passAiGatewayKey` is enabled, the batch executor resolves a host-side AI Gateway token and passes it into each worker execution so the worker sandbox can receive an AI Gateway network policy transform. Without that option, the reviewed code does not apply an explicit worker network policy.

## Findings

| Priority | Finding | Evidence | Impact | Recommendation |
| --- | --- | --- | --- | --- |
| Resolved | Normal lifecycle truth no longer depends on manual snapshot IDs. | `prepareRestoreTarget()` stamps `persistedStateDynamicConfigHash`, `persistedStateAssetSha256`, `persistedStateSavedAt`, and `persistedStateSource`; restore attestation accepts fresh persisted state without `snapshotId`. | Legacy snapshot fields still exist for manual snapshots and compatibility. | Keep future restore-prepared code keyed to `persistedState*` fields unless working on explicit snapshot APIs. |
| Resolved by docs | Credential-brokering docs now match current behavior. | `buildRuntimeEnv()` can pass AI Gateway tokens into sandbox env during bootstrap; network policy transforms remain the host-controlled refresh path. | Operators no longer get a stronger guarantee than the code provides. | Remove the env fallback in code before restoring a "credential never enters the VM" claim. |
| Resolved | Lifecycle docs now describe the v2 resume path. | `docs/lifecycle-and-restore.md` documents `Sandbox.get({ name, resume: true })` first, create fallback, and `resume: false` observation. | Operators have the right SDK path for wake debugging. | Keep docs aligned with official v2 docs and controller behavior. |
| Must fix | SDK error classification is inconsistent. | Snapshot delete uses `APIError`; other lifecycle cleanup paths classify gone sandboxes with string matching. | Beta SDK error text changes can break recovery or mask real failures. | Centralize Vercel Sandbox error classification around `APIError`, response/status fields, and string fallback only as a last resort. |
| Must fix | Worker sandbox threat model is underdocumented. | Worker execution accepts command specs, writes files under `/workspace`, and only applies network policy when an AI Gateway token option is used. | Internal endpoint misuse can run arbitrary commands with platform-default egress. | Document worker sandboxes as trusted internal execution, or enforce an explicit default network policy for every worker sandbox. |
| High | Raw debug sandbox timing bypasses normal controller/resource handling. | `/api/debug/sandbox-timing` imports `Sandbox` directly, accepts raw `vcpus`, calls `sandbox.snapshot()`, and only stops in cleanup. | Diagnostic runs can exercise unsupported resources or leave diagnostic artifacts outside normal tracking. | Keep it gated, validate resources with the same helper as production, document it as raw SDK diagnostics, and consider delete/cleanup of diagnostic sandboxes/snapshots. |
| High | `readFileToBuffer` hides read errors. | The controller wrapper catches any read failure and returns `null`. | Cron persistence, asset manifest reads, and worker captures can silently treat read failures as missing files. | Return structured read results internally or log unexpected errors while preserving `null` for known missing-file cases. |
| High | Network policy shapes depend on beta semantics. | Disabled/learning without a token can use string form; token paths use object form with transform rules and `"*": []`. | SDK behavior changes could alter egress policy or AI Gateway transform behavior. | Add SDK contract/smoke coverage for disabled, learning, enforcing, and transform policy shapes. |
| Medium | Worker commands lack explicit command abort signals. | Worker route has `maxDuration = 300` and sandbox timeout clamping, but `runCommand` is called without a signal. | Long commands rely on platform/function timeout rather than command-scoped cancellation. | Pass `AbortSignal.timeout(...)` based on route and sandbox timeout budgets. |
| Medium | Detached command wrapper is not evidenced as used. | `runDetachedCommand()` and `getCommand().kill()` are exposed by the wrapper and fake controller. | First real use could discover SDK shape drift late. | Add contract tests/documentation before relying on it, or remove the unused wrapper surface. |

## Good Patterns to Preserve

- Keep production SDK access centralized in `SandboxController` / `SandboxHandle`.
- Keep `_setSandboxControllerForTesting()` limited to `NODE_ENV=test`, so production cannot accidentally swap the real SDK.
- Keep metadata parking before `stop({ blocking: false })`; it prevents concurrent heartbeats from waking a sandbox while stop is being accepted.
- Keep `resume: false` for snapshotting reconciliation.
- Keep lifecycle locks with renewal around long create/restore/stop work.
- Keep fail-closed firewall behavior in enforcing mode.
- Keep resource clamping for main and worker sandbox creation.
- Keep debug routes gated behind debug enablement and mutation auth.

## Recommended Follow-ups

1. Keep the persisted-state truth model aligned across lifecycle code, hot-spare behavior, reset snapshot deletion, restore-prepared metadata, docs, and tests.
2. Consider removing the AI Gateway bootstrap-env fallback so credential brokering can become network-policy-only.
3. Keep lifecycle docs synced with official Sandbox v2 resume/observe semantics.
4. Add a shared Vercel Sandbox SDK error classifier and migrate lifecycle cleanup/reset paths to it.
5. Document the worker sandbox security model and decide whether every worker sandbox should receive an explicit network policy.
6. Add SDK contract tests for beta-sensitive surfaces: create/get resume semantics, stop blocking modes, status names, command output shape, network policy forms, transform rules, snapshot delete, and timeout behavior.
7. Harden `/api/debug/sandbox-timing` resource validation and cleanup semantics.
8. Improve sandbox file-read error reporting where silent `null` can hide operational failures.

## Oracle Run Evidence

The report was derived from an `$oracle-packx` run with slug `vercel-sandbox-api-audit`. The bundle was written to `~/.oracle/bundles/vercel-sandbox-api-audit.txt`, and the Oracle browser session completed after roughly 10.5 minutes with a 29k-character response. The Oracle session telemetry was written under `~/.oracle/sessions/vercel-sandbox-api-audit/`; due to an Oracle CLI logging issue, the final assistant response was returned through the PTY rather than persisted in `output.log`.
