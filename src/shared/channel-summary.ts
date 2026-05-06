import type { WhatsAppLinkState } from "@/shared/channels";

export const WHATSAPP_SUMMARY_DETAIL_ROUTE = "/api/channels/whatsapp" as const;
export const WHATSAPP_CONNECTION_SEMANTICS = "delivery-enabled" as const;

export type ChannelSummaryEntry = {
  /**
   * Legacy field kept for backward compatibility.
   * For all current channels this is equivalent to `configured`.
   */
  connected: boolean;
  configured: boolean;
  lastError: string | null;
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
  };
};

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
