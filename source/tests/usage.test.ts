import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/types";
import {
  reserveCloudQuota,
  recordUsageAttempt,
  clearUsageStore,
  checkDailyCloudQuota,
} from "../src/usage";

test("concurrent requests and retries cannot exceed the daily request quota", async () => {
  const original = globalThis.chrome;
  const data: Record<string, unknown> = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async () => structuredClone(data),
          set: async (patch: Record<string, unknown>) => {
            Object.assign(data, structuredClone(patch));
          },
        },
      },
    },
  });
  try {
    await clearUsageStore();
    const config = { ...DEFAULTS, dailyRequestLimit: 1 };
    const calls = await Promise.allSettled([
      reserveCloudQuota(config),
      reserveCloudQuota(config),
    ]);
    assert.equal(calls.filter((r) => r.status === "fulfilled").length, 1);
    recordUsageAttempt({
      channel: "cloud",
      modelKey: "test",
      isRetry: false,
      promptTokens: 2,
      completionTokens: 1,
      chars: 3,
    });
    for (const r of calls) if (r.status === "fulfilled") r.value();
    await assert.rejects(reserveCloudQuota(config), /DAILY_QUOTA_REACHED/);
    await clearUsageStore();
    await checkDailyCloudQuota(config);
  } finally {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: original,
    });
  }
});
