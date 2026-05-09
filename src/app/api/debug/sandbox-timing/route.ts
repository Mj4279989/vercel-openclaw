import { jsonError, jsonOk, ApiError } from "@/shared/http";
import { requireMutationAuth } from "@/server/auth/route-auth";
import { requireDebugEnabled } from "@/server/auth/debug-guard";

const ALLOWED_VCPUS = new Set([1, 2, 4, 8]);

export async function POST(request: Request): Promise<Response> {
  const blocked = requireDebugEnabled();
  if (blocked) return blocked;

  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const snapshotId = url.searchParams.get("snapshotId") ?? process.env.DEBUG_SANDBOX_SNAPSHOT_ID;
  if (!snapshotId) {
    return jsonError(
      new ApiError(400, "MISSING_SNAPSHOT_ID", "Provide snapshotId query param or set DEBUG_SANDBOX_SNAPSHOT_ID env var."),
    );
  }
  const vcpus = Number(url.searchParams.get("vcpus") ?? "1");
  if (!Number.isInteger(vcpus) || !ALLOWED_VCPUS.has(vcpus)) {
    return jsonError(
      new ApiError(400, "INVALID_VCPUS", "vcpus must be one of 1, 2, 4, or 8."),
    );
  }

  const timings: Record<string, number> = {};
  const logs: string[] = [];
  let sandbox: Awaited<ReturnType<typeof import("@vercel/sandbox").Sandbox.create>> | null = null;

  try {
    const t0 = performance.now();
    const { Sandbox } = await import("@vercel/sandbox");
    timings.sdkImportMs = performance.now() - t0;

    const t1 = performance.now();
    sandbox = await Sandbox.create({
      source: { type: "snapshot", snapshotId },
      persistent: false,
      ports: [3000],
      timeout: 60_000,
      resources: { vcpus },
    });
    timings.createMs = performance.now() - t1;
    logs.push(`sandboxId=${sandbox.name}`);

    const t2 = performance.now();
    const echoResult = await sandbox.runCommand("echo", ["hello"]);
    timings.echoMs = performance.now() - t2;
    const echoOut = await echoResult.output("stdout");
    logs.push(`echo exitCode=${echoResult.exitCode} stdout=${echoOut.trim()}`);

    const t3 = performance.now();
    const exitResult = await sandbox.runCommand("sh", ["-c", "exit 0"]);
    timings.shExitMs = performance.now() - t3;
    logs.push(`sh-exit exitCode=${exitResult.exitCode}`);

    const t4 = performance.now();
    const sleepResult = await sandbox.runCommand("sh", ["-c", "sleep 0.1 && echo done"]);
    timings.shSleepMs = performance.now() - t4;
    const sleepOut = await sleepResult.output("stdout");
    logs.push(`sh-sleep exitCode=${sleepResult.exitCode} stdout=${sleepOut.trim()}`);

    const t5 = performance.now();
    await sandbox.snapshot();
    timings.snapshotMs = performance.now() - t5;

    timings.totalMs = performance.now() - t0;

    return jsonOk({ snapshotId, vcpus, timings, logs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("sandbox-timing error", error);
    return Response.json(
      { error: "SANDBOX_TIMING_ERROR", message, timings, logs },
      { status: 500 },
    );
  } finally {
    if (sandbox) {
      try {
        await sandbox.stop({ blocking: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
