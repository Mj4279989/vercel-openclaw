import type { ChannelLastForward, ChannelName } from "@/shared/channels";
import { logInfo, logWarn } from "@/server/log";
import { mutateMeta } from "@/server/store/store";

/**
 * Persist most-recent forward outcome to `meta.channelDiagnostics.<ch>.
 * lastForward` so /api/channels/summary, /api/admin/why-not-ready, and
 * channel UI panels can surface ongoing delivery health (distinct from
 * the one-shot config-sync state).
 *
 * Both the Slack fast path (POST /api/channels/slack/webhook → direct
 * fetch) and the workflow path (drainChannelWorkflow → forwardToNative
 * HandlerWithRetry) call this. Writes are best-effort: failure does not
 * abort delivery.
 */
export async function recordChannelLastForward(
  channel: ChannelName,
  forward: ChannelLastForward,
): Promise<void> {
  try {
    await mutateMeta((next) => {
      if (!next.channelDiagnostics) next.channelDiagnostics = {};
      next.channelDiagnostics[channel] = { lastForward: forward };
    });
    logInfo("channels.forward_outcome", {
      channel,
      ok: forward.ok,
      classification: forward.classification,
      attempts: forward.attempts,
      totalMs: forward.totalMs,
      sandboxUrl: forward.sandboxUrl,
      sandboxId: forward.sandboxId,
      transport: forward.transport,
      deliveryId: forward.deliveryId,
    });
  } catch (err) {
    logWarn("channels.last_forward_persist_failed", {
      channel,
      error: err instanceof Error ? err.message : String(err),
      deliveryId: forward.deliveryId,
    });
  }
}
