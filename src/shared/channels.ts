export const CHANNEL_NAMES = ["slack", "telegram", "discord", "whatsapp"] as const;

export type ChannelName = (typeof CHANNEL_NAMES)[number];

export function isChannelName(value: string): value is ChannelName {
  return (CHANNEL_NAMES as readonly string[]).includes(value);
}

export type ChannelMode = "webhook-proxied" | "gateway-native";

export type SlackLiveConfigSyncState = {
  outcome: "skipped" | "applied" | "degraded" | "failed";
  reason: string;
  liveConfigFresh: boolean;
  checkedAt: number;
  operatorMessage?: string | null;
};

export type SlackChannelConfig = {
  signingSecret: string;
  botToken: string;
  configuredAt: number;
  team?: string;
  user?: string;
  botId?: string;
  lastError?: string;
  liveConfigSync?: SlackLiveConfigSyncState;
};

export type TelegramChannelConfig = {
  botToken: string;
  webhookSecret: string;
  previousWebhookSecret?: string;
  previousSecretExpiresAt?: number;
  webhookUrl: string;
  botUsername: string;
  configuredAt: number;
  commandSyncStatus?: "synced" | "unsynced" | "error";
  commandsRegisteredAt?: number;
  commandSyncError?: string;
  lastError?: string;
};

export type DiscordChannelConfig = {
  publicKey: string;
  applicationId: string;
  botToken: string;
  configuredAt: number;
  appName?: string;
  botUsername?: string;
  endpointConfigured?: boolean;
  endpointUrl?: string;
  endpointError?: string;
  commandRegistered?: boolean;
  commandId?: string;
  commandRegisteredAt?: number;
};

export type WhatsAppLinkState =
  | "unconfigured"
  | "needs-plugin"
  | "needs-login"
  | "linked"
  | "disconnected"
  | "error";

export type WhatsAppChannelConfig = {
  enabled: boolean;
  configuredAt: number;
  phoneNumberId?: string;
  accessToken?: string;
  verifyToken?: string;
  appSecret?: string;
  businessAccountId?: string;
  pluginSpec?: string;
  accountId?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: string[];
  groups?: string[];
  lastKnownLinkState?: WhatsAppLinkState;
  linkedPhone?: string;
  displayName?: string;
  lastError?: string;
};

export type ChannelConfigs = {
  slack: SlackChannelConfig | null;
  telegram: TelegramChannelConfig | null;
  discord: DiscordChannelConfig | null;
  whatsapp: WhatsAppChannelConfig | null;
};

/**
 * Most-recent forward attempt result, recorded per inbound webhook.
 *
 * Operator surfaces (e.g. /api/channels/summary readiness) read this to
 * report ongoing delivery health, distinct from the one-shot config-sync
 * outcome captured in {@link SlackLiveConfigSyncState}. A failed forward
 * after a successful config-sync is the signal that something has gone
 * stale (sandbox suspended, public URL dead, plugin not registered).
 */
export type ChannelLastForward = {
  ok: boolean;
  status: number | null;
  /**
   * One of the forward classifier values:
   *   "accepted" | "handler-not-ready" | "sandbox-not-listening" |
   *   "proxy-error" | "fetch-exception" | "handler-error" |
   *   "swallowed-by-base-server" | "exhausted"
   */
  classification: string;
  attempts: number;
  totalMs: number;
  transport: "public" | "local" | null;
  /** Cached sandbox public URL used for the last attempt, or null when unknown. */
  sandboxUrl: string | null;
  /** Sandbox ID at forward time, or null. */
  sandboxId: string | null;
  /** First ~200 chars of the final attempt's response body (debugging aid). */
  finalReasonHead: string | null;
  startedAt: number;
  completedAt: number;
  deliveryId: string | null;
};

export type ChannelDiagnostics = Partial<Record<ChannelName, { lastForward?: ChannelLastForward }>>;

export function isChannelLastForward(value: unknown): value is ChannelLastForward {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Partial<ChannelLastForward>;
  return (
    typeof raw.ok === "boolean" &&
    typeof raw.classification === "string" &&
    typeof raw.attempts === "number" &&
    typeof raw.totalMs === "number" &&
    typeof raw.startedAt === "number" &&
    typeof raw.completedAt === "number"
  );
}

export function createDefaultChannelConfigs(): ChannelConfigs {
  return {
    slack: null,
    telegram: null,
    discord: null,
    whatsapp: null,
  };
}

export function ensureChannelConfigs(input: unknown): ChannelConfigs {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createDefaultChannelConfigs();
  }

  const raw = input as Partial<ChannelConfigs>;
  return {
    slack: isSlackChannelConfig(raw.slack) ? raw.slack : null,
    telegram: isTelegramChannelConfig(raw.telegram) ? raw.telegram : null,
    discord: isDiscordChannelConfig(raw.discord) ? raw.discord : null,
    whatsapp: isWhatsAppChannelConfig(raw.whatsapp) ? raw.whatsapp : null,
  };
}

function isSlackChannelConfig(value: unknown): value is SlackChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<SlackChannelConfig>;
  return (
    typeof raw.signingSecret === "string" &&
    typeof raw.botToken === "string" &&
    typeof raw.configuredAt === "number"
  );
}

function isTelegramChannelConfig(value: unknown): value is TelegramChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<TelegramChannelConfig>;
  return (
    typeof raw.botToken === "string" &&
    typeof raw.webhookSecret === "string" &&
    typeof raw.webhookUrl === "string" &&
    typeof raw.botUsername === "string" &&
    typeof raw.configuredAt === "number" &&
    (raw.previousWebhookSecret === undefined || typeof raw.previousWebhookSecret === "string") &&
    (raw.previousSecretExpiresAt === undefined || typeof raw.previousSecretExpiresAt === "number") &&
    (raw.commandSyncStatus === undefined ||
      raw.commandSyncStatus === "synced" ||
      raw.commandSyncStatus === "unsynced" ||
      raw.commandSyncStatus === "error") &&
    (raw.commandsRegisteredAt === undefined || typeof raw.commandsRegisteredAt === "number") &&
    (raw.commandSyncError === undefined || typeof raw.commandSyncError === "string") &&
    (raw.lastError === undefined || typeof raw.lastError === "string")
  );
}

function isDiscordChannelConfig(value: unknown): value is DiscordChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<DiscordChannelConfig>;
  return (
    typeof raw.publicKey === "string" &&
    typeof raw.applicationId === "string" &&
    typeof raw.botToken === "string" &&
    typeof raw.configuredAt === "number"
  );
}

function isWhatsAppChannelConfig(value: unknown): value is WhatsAppChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Partial<WhatsAppChannelConfig>;
  return (
    typeof raw.enabled === "boolean" &&
    typeof raw.configuredAt === "number" &&
    (raw.phoneNumberId === undefined || typeof raw.phoneNumberId === "string") &&
    (raw.accessToken === undefined || typeof raw.accessToken === "string") &&
    (raw.verifyToken === undefined || typeof raw.verifyToken === "string") &&
    (raw.appSecret === undefined || typeof raw.appSecret === "string") &&
    (raw.businessAccountId === undefined || typeof raw.businessAccountId === "string") &&
    (raw.pluginSpec === undefined || typeof raw.pluginSpec === "string") &&
    (raw.accountId === undefined || typeof raw.accountId === "string") &&
    (raw.dmPolicy === undefined ||
      raw.dmPolicy === "pairing" ||
      raw.dmPolicy === "allowlist" ||
      raw.dmPolicy === "open" ||
      raw.dmPolicy === "disabled") &&
    (raw.allowFrom === undefined ||
      (Array.isArray(raw.allowFrom) && raw.allowFrom.every((entry) => typeof entry === "string"))) &&
    (raw.groupPolicy === undefined ||
      raw.groupPolicy === "open" ||
      raw.groupPolicy === "allowlist" ||
      raw.groupPolicy === "disabled") &&
    (raw.groupAllowFrom === undefined ||
      (Array.isArray(raw.groupAllowFrom) &&
        raw.groupAllowFrom.every((entry) => typeof entry === "string"))) &&
    (raw.groups === undefined ||
      (Array.isArray(raw.groups) && raw.groups.every((entry) => typeof entry === "string"))) &&
    (raw.lastKnownLinkState === undefined ||
      raw.lastKnownLinkState === "unconfigured" ||
      raw.lastKnownLinkState === "needs-plugin" ||
      raw.lastKnownLinkState === "needs-login" ||
      raw.lastKnownLinkState === "linked" ||
      raw.lastKnownLinkState === "disconnected" ||
      raw.lastKnownLinkState === "error") &&
    (raw.linkedPhone === undefined || typeof raw.linkedPhone === "string") &&
    (raw.displayName === undefined || typeof raw.displayName === "string") &&
    (raw.lastError === undefined || typeof raw.lastError === "string")
  );
}

export function hasWhatsAppBusinessCredentials(
  config: WhatsAppChannelConfig | null | undefined,
): config is WhatsAppChannelConfig & {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  appSecret: string;
} {
  return Boolean(
    config?.phoneNumberId &&
      config.accessToken &&
      config.verifyToken &&
      config.appSecret,
  );
}
