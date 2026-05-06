/**
 * Shared post-mutation helper for channel config changes.
 *
 * Both the admin channel route factory (PUT/DELETE) and the Slack OAuth
 * install callback delegate here after persisting credentials.  This
 * eliminates the duplicated markRestoreTargetDirty → syncGatewayConfigToSandbox
 * → error-normalisation → logging block that previously lived in two places.
 */

import type { ChannelName } from "@/shared/channels";
import type { LiveConfigSyncResult } from "@/shared/live-config-sync";
import { logInfo, logWarn } from "@/server/log";
import { mutateMeta } from "@/server/store/store";
import {
  markRestoreTargetDirty,
  syncGatewayConfigToSandbox,
} from "@/server/sandbox/lifecycle";

// ── Public types ──────────────────────────────────────────────────────

export type ChannelConfigMutationOperation =
  | "put"
  | "delete"
  | "oauth-install";

export type ChannelConfigApplyOutcome = {
  liveConfigSync: LiveConfigSyncResult;
  needsOperatorWarning: boolean;
};

// ── Helper ────────────────────────────────────────────────────────────

export async function applyChannelConfigChange(params: {
  channel: ChannelName;
  operation: ChannelConfigMutationOperation;
}): Promise<ChannelConfigApplyOutcome> {
  const { channel, operation } = params;

  await markRestoreTargetDirty({ reason: "dynamic-config-changed" });

  let liveConfigSync: LiveConfigSyncResult;
  try {
    liveConfigSync = await syncGatewayConfigToSandbox();
  } catch (syncError) {
    const reason =
      syncError instanceof Error ? syncError.message : String(syncError);
    liveConfigSync = {
      outcome: "failed",
      reason,
      liveConfigFresh: false,
      operatorMessage:
        "Config sync failed. The sandbox may be serving stale configuration.",
    };
  }

  if (channel === "slack") {
    await mutateMeta((meta) => {
      if (meta.channels.slack) {
        meta.channels.slack.liveConfigSync = {
          outcome: liveConfigSync.outcome,
          reason: liveConfigSync.reason,
          liveConfigFresh: liveConfigSync.liveConfigFresh,
          operatorMessage: liveConfigSync.operatorMessage,
          checkedAt: Date.now(),
        };
      }
    });
  }

  // Single canonical log event for all channel config mutations.
  const logPayload = {
    channel,
    operation,
    outcome: liveConfigSync.outcome,
    reason: liveConfigSync.reason,
    liveConfigFresh: liveConfigSync.liveConfigFresh,
  };

  if (
    liveConfigSync.outcome === "degraded" ||
    liveConfigSync.outcome === "failed"
  ) {
    logWarn("channels.config_apply_outcome", logPayload);
  } else {
    logInfo("channels.config_apply_outcome", logPayload);
  }

  return {
    liveConfigSync,
    needsOperatorWarning:
      liveConfigSync.outcome === "degraded" ||
      liveConfigSync.outcome === "failed",
  };
}
