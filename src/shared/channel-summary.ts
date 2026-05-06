import type { ChannelLastForward, WhatsAppLinkState } from "@/shared/channels";

export const WHATSAPP_SUMMARY_DETAIL_ROUTE = "/api/channels/whatsapp" as const;
export const WHATSAPP_CONNECTION_SEMANTICS = "delivery-enabled" as const;

/**
 * Compact projection of {@link ChannelLastForward} suitable for the summary
 * API. Includes the fields an operator needs to triage delivery health
 * without paging through full attempt timelines.
 */
export type ChannelLastForwardSummary = {
  ok: boolean;
  classification: string;
  status: number | null;
  attempts: number;
  totalMs: number;
  sandboxUrl: string | null;
  sandboxId: string | null;
  finalReasonHead: string | null;
  completedAt: number;
  ageMs: number;
};

export type ChannelSummaryEntry = {
  /**
   * Legacy field kept for backward compatibility.
   * For all current channels this is equivalent to `configured`.
   */
  connected: boolean;
  configured: boolean;
  lastError: string | null;
  /** Most-recent forward attempt result (null if no forward has been recorded). */
  lastForward?: ChannelLastForwardSummary | null;
};

export type SlackSummaryEntry = ChannelSummaryEntry & {
  /**
   * True only when credentials are saved and the running sandbox has accepted
   * the latest Slack config sync, including route registration for /slack/events.
   */
  deliveryReady: boolean;
  routeReady: boolean;
  liveConfigFresh: boolean;
  readiness: {
    configSyncOutcome: "skipped" | "applied" | "degraded" | "failed" | null;
    reason: string | null;
    checkedAt: number | null;
    operatorMessage: string | null;
    sandboxPath: "/slack/events";
    /**
     * Most-recent forward outcome (live delivery health). Distinct from
     * configSyncOutcome (one-shot, set during OAuth callback). When this
     * disagrees with configSyncOutcome — e.g. configSync = "applied" but
     * lastForward.classification = "sandbox-not-listening" — something has
     * gone stale since the config was applied.
     */
    lastForward: ChannelLastForwardSummary | null;
  };
};

export function projectChannelLastForward(
  raw: ChannelLastForward | null | undefined,
  now: number = Date.now(),
): ChannelLastForwardSummary | null {
  if (!raw) return null;
  return {
    ok: raw.ok,
    classification: raw.classification,
    status: raw.status,
    attempts: raw.attempts,
    totalMs: raw.totalMs,
    sandboxUrl: raw.sandboxUrl,
    sandboxId: raw.sandboxId,
    finalReasonHead: raw.finalReasonHead,
    completedAt: raw.completedAt,
    ageMs: Math.max(0, now - raw.completedAt),
  };
}

export type WhatsAppSummaryEntry = ChannelSummaryEntry & {
  /**
   * Raw gateway-side link/session state. Distinct from the coarse
   * `connected/configured` flag so clients can reason without reading
   * source comments.
   */
  linkState: WhatsAppLinkState;
  connectionSemantics: typeof WHATSAPP_CONNECTION_SEMANTICS;
  detailRoute: typeof WHATSAPP_SUMMARY_DETAIL_ROUTE;
  deliveryMode: "webhook-proxied";
  requiresRunningSandbox: false;
};

export type ChannelSummaryResponse = {
  slack: SlackSummaryEntry;
  telegram: ChannelSummaryEntry;
  discord: ChannelSummaryEntry;
  whatsapp: WhatsAppSummaryEntry;
};
