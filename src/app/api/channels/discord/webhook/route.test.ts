import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

import { discordWebhookWorkflowRuntime } from "@/app/api/channels/discord/webhook/route";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import { withHarness } from "@/test-utils/harness";
import { callRoute, resetAfterCallbacks } from "@/test-utils/route-caller";
import { buildDiscordPing, buildDiscordWebhook } from "@/test-utils/webhook-builders";

let discordRouteModule:
  | typeof import("@/app/api/channels/discord/webhook/route")
  | null = null;

function getDiscordWebhookRoute() {
  if (!discordRouteModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    discordRouteModule = require("@/app/api/channels/discord/webhook/route") as typeof import("@/app/api/channels/discord/webhook/route");
  }
  return discordRouteModule;
}

test("Discord webhook: PING returns pong without starting workflow", async () => {
  await withHarness(async (h) => {
    _resetLogBuffer();
    const secrets = h.configureAllChannels();
    const route = getDiscordWebhookRoute();
    const startMock = mock.method(discordWebhookWorkflowRuntime, "start", async () => {});

    try {
      const result = await callRoute(
        route.POST,
        buildDiscordPing({
          privateKey: secrets.discordPrivateKey,
          publicKeyHex: secrets.discordPublicKeyHex,
        }),
      );

      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { type: 1 });
      assert.equal(startMock.mock.callCount(), 0);
      assert.ok(
        getServerLogs().some((entry) => entry.message === "channels.discord_ping_ack"),
        "PING ack should be logged separately from deferred interaction handling",
      );
    } finally {
      startMock.mock.restore();
      resetAfterCallbacks();
    }
  });
});

test("Discord webhook: deferred interaction preserves raw body and signature headers", async () => {
  await withHarness(async (h) => {
    _resetLogBuffer();
    const secrets = h.configureAllChannels();
    const route = getDiscordWebhookRoute();
    const payload = {
      id: "interaction-raw-1",
      type: 2,
      token: "interaction-token-raw-1",
      application_id: "app-raw-1",
      channel_id: "channel-raw-1",
      guild_id: "guild-raw-1",
      member: { user: { id: "user-raw-1" } },
      data: { name: "ask", options: [{ name: "text", value: "hello" }] },
    };
    const request = buildDiscordWebhook({
      privateKey: secrets.discordPrivateKey,
      publicKeyHex: secrets.discordPublicKeyHex,
      payload,
    });
    const expectedRawBody = JSON.stringify(payload);
    type CapturedDiscordEnvelope = {
      channel?: unknown;
      workflowHandoff?: {
        discordForwardHeaders?: Record<string, string>;
        discordRawBody?: string;
      };
    };
    const capturedEnvelopes: CapturedDiscordEnvelope[] = [];
    const startMock = mock.method(discordWebhookWorkflowRuntime, "start", async (_workflow: unknown, args: unknown[]) => {
      capturedEnvelopes.push(args[0] as CapturedDiscordEnvelope);
    });

    try {
      const result = await callRoute(route.POST, request);

      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { type: 5 });
      assert.equal(startMock.mock.callCount(), 1);
      assert.equal(capturedEnvelopes.length, 1);
      const envelope = capturedEnvelopes[0]!;
      assert.equal(envelope.channel, "discord");
      const handoff = envelope.workflowHandoff;
      assert.ok(handoff, "workflow handoff should be present");
      assert.equal(handoff.discordRawBody, expectedRawBody);
      assert.equal(
        handoff.discordForwardHeaders?.["x-signature-ed25519"],
        request.headers.get("x-signature-ed25519"),
      );
      assert.equal(
        handoff.discordForwardHeaders?.["x-signature-timestamp"],
        request.headers.get("x-signature-timestamp"),
      );
      assert.equal(handoff.discordForwardHeaders?.["content-type"], "application/json");

      const accepted = getServerLogs().find(
        (entry) => entry.message === "channels.discord_webhook_accepted",
      );
      assert.ok(accepted, "deferred Discord ack should be logged");
      assert.equal(accepted?.data?.ackSemantics, "deferred-only");
      assert.equal(accepted?.data?.responseType, 5);
      assert.equal(accepted?.data?.interactionId, "interaction-raw-1");
    } finally {
      startMock.mock.restore();
      resetAfterCallbacks();
    }
  });
});
