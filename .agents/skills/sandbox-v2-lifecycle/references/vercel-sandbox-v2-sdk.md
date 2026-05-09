# Vercel Sandbox v2 SDK Notes

Use this reference for SDK boundary work in `src/server/sandbox/controller.ts` and lifecycle callers.

## SDK Surfaces

- `Sandbox.create({ name, persistent, ports, timeout, resources, env, networkPolicy })` creates the persistent OpenClaw sandbox or short-lived worker/debug sandboxes.
- `Sandbox.get({ name, resume })` retrieves a sandbox by name. Use `resume:true` for wake and `resume:false` for observation.
- `sandbox.runCommand(...)` runs commands and may auto-resume stopped persistent sandboxes.
- `sandbox.writeFiles(...)` and `sandbox.readFileToBuffer(...)` move files in/out of the sandbox.
- `sandbox.domain(port)` resolves the public URL for a port.
- `sandbox.update({ networkPolicy })` applies firewall/AI Gateway policy and does not auto-resume a stopped persistent sandbox.
- `sandbox.stop({ blocking })` stops the current session; blocking waits for stopped state.
- `sandbox.delete()` permanently deletes the sandbox.

## Repo Rules

- Keep production SDK access behind `SandboxController` unless a route is explicitly documented as raw SDK diagnostics.
- Treat SDK status names and API error shapes as beta-sensitive. Prefer centralized error classification over string matching.
- Make worker/debug sandboxes explicit with `persistent:false`.
- Preserve the test-only controller override guard: production must always use the real SDK.
