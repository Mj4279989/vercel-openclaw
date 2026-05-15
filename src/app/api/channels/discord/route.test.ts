import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetStoreForTesting,
  getInitializedMeta,
  mutateMeta,
} from "@/server/store/store";
import {
  buildAuthGetRequest,
  buildPostRequest,
  buildPutRequest,
  callRoute,
  getDiscordChannelRoute,
  getDiscordRegisterCommandRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

patchNextServerAfter();

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "VERCEL_AUTH_MODE",
    "REDIS_URL",
    "KV_URL",
    "ADMIN_SECRET",
    "SESSION_SECRET",
    "NEXT_PUBLIC_APP_URL",
    "VERCEL_AUTOMATION_BYPASS_SECRET",
  ];
  const originals: Record<string, string | undefined> = {};
  for (const key of keys) originals[key] = process.env[key];

  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-discord-route";
  process.env.NEXT_PUBLIC_APP_URL = "https://openclaw.example";
  _resetStoreForTesting();

  try {
    await fn();
  } finally {
    for (const key of keys) {
      if (originals[key] === undefined) delete process.env[key];
      else (process.env as Record<string, string | undefined>)[key] = originals[key];
    }
    _resetStoreForTesting();
    resetAfterCallbacks();
  }
}

type FetchCall = { url: string; method: string; body: string | null };

type DiscordEndpointConflictResponse = {
  error: { code: string };
  endpointConflict: {
    endpointDrift: boolean;
    repairHint: { method: "PUT"; forceOverwriteEndpoint: true };
  };
};

type DiscordDiagnosticsResponse = {
  diagnostics: {
    currentEndpointUrl: string | null;
    desiredEndpointUrl: string;
    endpointDrift: boolean;
    endpointConfigured: boolean | undefined;
    commandRegistered: boolean;
    commandId: string | null;
    canRepairEndpoint: boolean;
  };
};

function installDiscordFetch(options: {
  currentEndpoint?: string | null;
  commandStatus?: number;
} = {}): { calls: FetchCall[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : null,
    });

    if (url.endsWith("/applications/@me") && method === "GET") {
      return Response.json({
        id: "app-123",
        verify_key: "ABCDEF",
        name: "TestBot",
        bot: { username: "testbot" },
        interactions_endpoint_url: options.currentEndpoint ?? null,
      });
    }

    if (url.endsWith("/applications/@me") && method === "PATCH") {
      return Response.json({ ok: true });
    }

    if (url.includes("/applications/app-123/commands") && method === "POST") {
      return options.commandStatus && options.commandStatus !== 200
        ? Response.json({ message: "command failed" }, { status: options.commandStatus })
        : Response.json({ id: "cmd-123" });
    }

    return Response.json({ message: `Unhandled ${method} ${url}` }, { status: 500 });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("PUT /api/channels/discord returns structured endpoint conflict without patching", async () => {
  await withTestEnv(async () => {
    const fake = installDiscordFetch({
      currentEndpoint: "https://old.example.com/api/channels/discord/webhook",
    });
    try {
      const route = getDiscordChannelRoute();
      const result = await callRoute(
        route.PUT!,
        buildPutRequest(
          "/api/channels/discord",
          JSON.stringify({ botToken: "Bot test-token" }),
          { authorization: "Bearer test-admin-secret-for-scenarios" },
        ),
      );

      assert.equal(result.status, 409);
      const body = result.json as DiscordEndpointConflictResponse;
      assert.equal(body.error.code, "DISCORD_ENDPOINT_CONFLICT");
      assert.equal(body.endpointConflict.endpointDrift, true);
      assert.deepEqual(body.endpointConflict.repairHint, {
        method: "PUT",
        forceOverwriteEndpoint: true,
      });
      assert.equal(
        fake.calls.some((call) => call.method === "PATCH"),
        false,
        "conflict must not silently patch Discord",
      );

      const meta = await getInitializedMeta();
      assert.equal(meta.channels.discord?.applicationId, "app-123");
      assert.equal(meta.channels.discord?.endpointConfigured, false);
      assert.equal(meta.channels.discord?.endpointUrl, "https://old.example.com/api/channels/discord/webhook");
    } finally {
      fake.restore();
    }
  });
});

test("PUT /api/channels/discord does not treat bypass query alone as endpoint conflict", async () => {
  await withTestEnv(async () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";
    const fake = installDiscordFetch({
      currentEndpoint: "https://openclaw.example/api/channels/discord/webhook",
    });
    try {
      const route = getDiscordChannelRoute();
      const result = await callRoute(
        route.PUT!,
        buildPutRequest(
          "/api/channels/discord",
          JSON.stringify({ botToken: "Bot test-token" }),
          { authorization: "Bearer test-admin-secret-for-scenarios" },
        ),
      );

      assert.equal(result.status, 200);
      const patch = fake.calls.find((call) => call.method === "PATCH");
      assert.ok(patch, "expected endpoint PATCH to keep protected delivery URL registered");
      assert.equal(
        JSON.parse(patch.body ?? "{}").interactions_endpoint_url,
        "https://openclaw.example/api/channels/discord/webhook?x-vercel-protection-bypass=bypass-secret",
      );

      const meta = await getInitializedMeta();
      assert.equal(meta.channels.discord?.endpointConfigured, true);
      assert.equal(meta.channels.discord?.endpointError, undefined);
    } finally {
      fake.restore();
    }
  });
});

test("PUT /api/channels/discord forceOverwriteEndpoint patches endpoint and registers command", async () => {
  await withTestEnv(async () => {
    const fake = installDiscordFetch({
      currentEndpoint: "https://old.example.com/api/channels/discord/webhook",
    });
    try {
      const route = getDiscordChannelRoute();
      const result = await callRoute(
        route.PUT!,
        buildPutRequest(
          "/api/channels/discord",
          JSON.stringify({
            botToken: "Bot test-token",
            forceOverwriteEndpoint: true,
          }),
          { authorization: "Bearer test-admin-secret-for-scenarios" },
        ),
      );

      assert.equal(result.status, 200);
      const patch = fake.calls.find((call) => call.method === "PATCH");
      assert.ok(patch, "expected endpoint PATCH");
      assert.equal(
        JSON.parse(patch.body ?? "{}").interactions_endpoint_url,
        "https://openclaw.example/api/channels/discord/webhook",
      );
      assert.ok(fake.calls.some((call) => call.url.includes("/applications/app-123/commands")));

      const meta = await getInitializedMeta();
      assert.equal(meta.channels.discord?.endpointConfigured, true);
      assert.equal(meta.channels.discord?.commandRegistered, true);
      assert.equal(meta.channels.discord?.commandId, "cmd-123");
    } finally {
      fake.restore();
    }
  });
});

test("GET /api/channels/discord diagnostics returns stable drift state", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.discord = {
        publicKey: "abcdef",
        applicationId: "app-123",
        botToken: "test-token",
        configuredAt: Date.now(),
        endpointConfigured: true,
        endpointUrl: "https://old.example.com/api/channels/discord/webhook",
        commandRegistered: true,
        commandId: "cmd-123",
      };
    });
    const fake = installDiscordFetch({
      currentEndpoint: "https://old.example.com/api/channels/discord/webhook",
    });
    try {
      const route = getDiscordChannelRoute();
      const result = await callRoute(
        route.GET!,
        buildAuthGetRequest("/api/channels/discord?diagnostics=1"),
      );

      assert.equal(result.status, 200);
      const body = result.json as DiscordDiagnosticsResponse;
      assert.equal(body.diagnostics.currentEndpointUrl, "https://old.example.com/api/channels/discord/webhook");
      assert.equal(body.diagnostics.desiredEndpointUrl, "https://openclaw.example/api/channels/discord/webhook");
      assert.equal(body.diagnostics.endpointDrift, true);
      assert.equal(body.diagnostics.endpointConfigured, false);
      assert.equal(body.diagnostics.commandRegistered, true);
      assert.equal(body.diagnostics.commandId, "cmd-123");
      assert.equal(body.diagnostics.canRepairEndpoint, true);
    } finally {
      fake.restore();
    }
  });
});

test("POST /api/channels/discord/register-command does not mutate endpoint fields", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.discord = {
        publicKey: "abcdef",
        applicationId: "app-123",
        botToken: "test-token",
        configuredAt: Date.now(),
        endpointConfigured: false,
        endpointUrl: "https://old.example.com/api/channels/discord/webhook",
        endpointError: "endpoint drift",
        commandRegistered: false,
      };
    });
    const fake = installDiscordFetch();
    try {
      const route = getDiscordRegisterCommandRoute();
      const result = await callRoute(
        route.POST!,
        buildPostRequest("/api/channels/discord/register-command", "{}", {
          authorization: "Bearer test-admin-secret-for-scenarios",
          "x-requested-with": "XMLHttpRequest",
        }),
      );

      assert.equal(result.status, 200);
      assert.equal(fake.calls.some((call) => call.method === "PATCH"), false);
      const meta = await getInitializedMeta();
      assert.equal(meta.channels.discord?.commandRegistered, true);
      assert.equal(meta.channels.discord?.endpointConfigured, false);
      assert.equal(meta.channels.discord?.endpointUrl, "https://old.example.com/api/channels/discord/webhook");
      assert.equal(meta.channels.discord?.endpointError, "endpoint drift");
    } finally {
      fake.restore();
    }
  });
});
