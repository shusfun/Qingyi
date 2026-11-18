import type { Config } from "./types";

export const USAGE_STORAGE_KEY = "usage.v1";

export interface UsageBucket {
  requests: number;
  retryRequests: number;
  promptTokens: number;
  completionTokens: number;
  chars: number;
}

export interface DailyUsageRecord {
  date: string;
  totalRequests: number;
  cloudRequests: number;
  localRequests: number;
  cloudPromptTokens: number;
  cloudCompletionTokens: number;
  localPromptTokens: number;
  localCompletionTokens: number;
  byModel: Record<string, UsageBucket>;
}

export interface UsageStoreData {
  days: Record<string, DailyUsageRecord>;
  totalCloudRequests: number;
  totalCloudRetries: number;
  totalLocalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  estimatedCount: number;
}

export type UsageStore = UsageStoreData;

function withAggregates(
  days: Record<string, DailyUsageRecord>,
): UsageStoreData {
  let totalCloudRequests = 0;
  let totalCloudRetries = 0;
  let totalLocalRequests = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let estimatedCount = 0;

  for (const day of Object.values(days)) {
    totalCloudRequests += day.cloudRequests || 0;
    totalLocalRequests += day.localRequests || 0;
    totalPromptTokens +=
      (day.cloudPromptTokens || 0) + (day.localPromptTokens || 0);
    totalCompletionTokens +=
      (day.cloudCompletionTokens || 0) + (day.localCompletionTokens || 0);
    for (const [k, b] of Object.entries(day.byModel || {})) {
      if (k.startsWith("cloud:")) totalCloudRetries += b.retryRequests || 0;
      if (b.chars > 0 && b.promptTokens > 0 && b.completionTokens === 0) {
        estimatedCount += 1;
      }
    }
  }

  return {
    days,
    totalCloudRequests,
    totalCloudRetries,
    totalLocalRequests,
    totalPromptTokens,
    totalCompletionTokens,
    estimatedCount,
  };
}

function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

let writeTail = Promise.resolve();
let quotaTail = Promise.resolve();
let pendingCloudRequests = 0;

export function reserveCloudQuota(c: Config): Promise<() => void> {
  const admission = quotaTail.then(async () => {
    await checkDailyCloudQuota(c);
    if ((c.dailyRequestLimit || 0) > 0) {
      const today = (await readUsageStore()).days[todayKey()];
      if (
        (today?.cloudRequests || 0) + pendingCloudRequests >=
        c.dailyRequestLimit!
      ) {
        throw new Error("DAILY_QUOTA_REACHED");
      }
    }
    pendingCloudRequests++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        pendingCloudRequests--;
      }
    };
  });
  quotaTail = admission.then(
    () => {},
    () => {},
  );
  return admission;
}

export async function readUsageStore(): Promise<UsageStoreData> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return withAggregates({});
  }
  const raw = await chrome.storage.local.get(USAGE_STORAGE_KEY);
  const store = raw?.[USAGE_STORAGE_KEY];
  if (!store || typeof store !== "object" || !store.days) {
    return withAggregates({});
  }
  return withAggregates(store.days as Record<string, DailyUsageRecord>);
}

export async function checkDailyCloudQuota(c: Config): Promise<void> {
  await writeTail.catch(() => {});
  const reqLimit = c.dailyRequestLimit || 0;
  const tokLimit = c.dailyTokenLimit || 0;
  if (reqLimit <= 0 && tokLimit <= 0) return;
  const store = await readUsageStore();
  const today = store.days[todayKey()];
  if (!today) return;
  if (reqLimit > 0 && today.cloudRequests >= reqLimit) {
    throw new Error("DAILY_QUOTA_REACHED");
  }
  const cloudTokens = today.cloudPromptTokens + today.cloudCompletionTokens;
  if (tokLimit > 0 && cloudTokens >= tokLimit) {
    throw new Error("DAILY_QUOTA_REACHED");
  }
}

export function recordUsageAttempt(params: {
  channel: "local" | "cloud";
  modelKey: string;
  isRetry: boolean;
  promptTokens: number;
  completionTokens: number;
  chars: number;
}): void {
  if (typeof chrome === "undefined" || !chrome.storage?.local?.set) return;
  writeTail = writeTail
    .catch(() => {})
    .then(async () => {
      const store = await readUsageStore();
      const date = todayKey();
      const day: DailyUsageRecord = store.days[date] || {
        date,
        totalRequests: 0,
        cloudRequests: 0,
        localRequests: 0,
        cloudPromptTokens: 0,
        cloudCompletionTokens: 0,
        localPromptTokens: 0,
        localCompletionTokens: 0,
        byModel: {},
      };
      day.totalRequests += 1;
      if (params.channel === "local") {
        day.localRequests += 1;
        day.localPromptTokens += params.promptTokens;
        day.localCompletionTokens += params.completionTokens;
      } else {
        day.cloudRequests += 1;
        day.cloudPromptTokens += params.promptTokens;
        day.cloudCompletionTokens += params.completionTokens;
      }
      const key = `${params.channel}:${params.modelKey}`;
      const bucket: UsageBucket = day.byModel[key] || {
        requests: 0,
        retryRequests: 0,
        promptTokens: 0,
        completionTokens: 0,
        chars: 0,
      };
      bucket.requests += 1;
      if (params.isRetry) bucket.retryRequests += 1;
      bucket.promptTokens += params.promptTokens;
      bucket.completionTokens += params.completionTokens;
      bucket.chars += params.chars;
      day.byModel[key] = bucket;
      store.days[date] = day;

      // Retain most recent 60 days to bound local storage footprint.
      const keys = Object.keys(store.days).sort();
      while (keys.length > 60) {
        const oldest = keys.shift()!;
        delete store.days[oldest];
      }
      await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: store });
    });
}

export async function clearUsageStore(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local?.set) return;
  writeTail = writeTail
    .catch(() => {})
    .then(() =>
      chrome.storage.local.set({ [USAGE_STORAGE_KEY]: { days: {} } }),
    );
  await writeTail;
}
