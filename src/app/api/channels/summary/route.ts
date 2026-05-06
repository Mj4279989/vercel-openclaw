import type { ChannelLastForward, WhatsAppLinkState } from "@/shared/channels";
import {
  type ChannelSummaryEntry,
  type ChannelSummaryResponse,
  type SlackSummaryEntry,
  type WhatsAppSummaryEntry,
  WHATSAPP_CONNECTION_SEMANTICS,
  WHATSAPP_SUMMARY_DETAIL_ROUTE,
  projectChannelLastForward,
} from "@/shared/channel-summary";
import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { logError, logInfo } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";
import { jsonError } from "@/shared/http";

function buildSummaryEntry(
  configured: boolean,
  lastError: string | null,
  lastForward: ChannelLastForward | null | undefined,
  now: number,
): ChannelSummaryEntry {
  return {
    connected: configured,
    configured,
    lastError,
    lastForward: projectChannelLastForward(lastForward, now),
  };
}

function buildSlackSummaryEntry(
  config:
    | {
        lastError?: string;
        liveConfigSync?: {
          outcome: "skipped" | "applied" | "degraded" | "failed";
          reason: string;
          liveConfigFresh: boolean;
          checkedAt: number;
          operatorMessage?: string | null;
        };
      }
    | null
    | undefined,
  lastForward: ChannelLastForward | null | undefined,
  now: number,
): SlackSummaryEntry {
  const configured = config !== null && config !== undefined;
  const liveConfigSync = config?.liveConfigSync ?? null;
  const liveConfigFresh = liveConfigSync?.liveConfigFresh === true;
  const lastForwardSummary = projectChannelLastForward(lastForward, now);

  // Delivery readiness now considers ongoing forward health, not just the
  // one-shot config-sync outcome. A successful config-sync followed by a
  // sandbox-not-listening forward is NOT ready — the public URL has gone
  // stale since the config was applied.
  const lastForwardSignalsBroken =
    lastForwardSummary !== null &&
    lastForwardSummary.ok === false &&
    (lastForwardSummary.classification === "sandbox-not-listening" ||
      lastForwardSummary.classification === "handler-not-ready" ||
      lastForwardSummary.classification === "exhausted");

  const deliveryReady = configured && liveConfigFresh && !lastForwardSignalsBroken;

  // Reason precedence:
  //   1. If the most recent forward broke, surface its classification — the
  //      operator wants to see the live failure mode, not the stale
  //      config-sync result.
  //   2. Otherwise fall back to liveConfigSync's reason, then to a generic
  //      "not yet verified" sentinel when configured but never forwarded.
  let reason: string | null;
  if (lastForwardSignalsBroken && lastForwardSummary) {
    reason = `last_forward_${lastForwardSummary.classification}`;
  } else if (liveConfigSync?.reason) {
    reason = liveConfigSync.reason;
  } else {
    reason = configured ? "slack_delivery_not_verified" : null;
  }

  return {
    connected: configured,
    configured,
    lastError: config?.lastError ?? null,
    lastForward: lastForwardSummary,
    deliveryReady,
    routeReady: deliveryReady,
    liveConfigFresh,
    readiness: {
      configSyncOutcome: liveConfigSync?.outcome ?? null,
      reason,
      checkedAt: liveConfigSync?.checkedAt ?? null,
      operatorMessage: liveConfigSync?.operatorMessage ?? null,
      sandboxPath: "/slack/events",
      lastForward: lastForwardSummary,
    },
  };
}

function buildWhatsAppSummaryEntry(
  config:
    | {
        enabled: boolean;
        lastKnownLinkState?: WhatsAppLinkState;
        lastError?: string;
      }
    | null
    | undefined,
  lastForward: ChannelLastForward | null | undefined,
  now: number,
): WhatsAppSummaryEntry {
  const configured = config?.enabled === true;

  const entry: WhatsAppSummaryEntry = {
    connected: configured,
    configured,
    linkState: config?.lastKnownLinkState ?? "unconfigured",
    lastError: config?.lastError ?? null,
    lastForward: projectChannelLastForward(lastForward, now),
    connectionSemantics: WHATSAPP_CONNECTION_SEMANTICS,
    detailRoute: WHATSAPP_SUMMARY_DETAIL_ROUTE,
    deliveryMode: "webhook-proxied",
    requiresRunningSandbox: false,
  };

  const hasProjectionGap =
    (entry.configured && entry.linkState !== "linked") ||
    (!entry.configured && entry.linkState !== "unconfigured") ||
    entry.lastError !== null;

  if (hasProjectionGap) {
    logInfo("channels.whatsapp_summary_projected", {
      configured: entry.configured,
      connected: entry.connected,
      linkState: entry.linkState,
      lastError: entry.lastError,
      connectionSemantics: entry.connectionSemantics,
      detailRoute: entry.detailRoute,
      deliveryMode: entry.deliveryMode,
      requiresRunningSandbox: entry.requiresRunningSandbox,
    });
  }

  return entry;
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();
    const now = Date.now();
    const diag = meta.channelDiagnostics ?? {};

    const body: ChannelSummaryResponse = {
      slack: buildSlackSummaryEntry(
        meta.channels.slack,
        diag.slack?.lastForward ?? null,
        now,
      ),
      telegram: buildSummaryEntry(
        meta.channels.telegram !== null,
        meta.channels.telegram?.lastError ?? null,
        diag.telegram?.lastForward ?? null,
        now,
      ),
      discord: buildSummaryEntry(
        meta.channels.discord !== null,
        meta.channels.discord?.endpointError ?? null,
        diag.discord?.lastForward ?? null,
        now,
      ),
      whatsapp: buildWhatsAppSummaryEntry(
        meta.channels.whatsapp,
        diag.whatsapp?.lastForward ?? null,
        now,
      ),
    };

    const response = Response.json(body);
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    logError("channels.summary_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(error);
  }
}
