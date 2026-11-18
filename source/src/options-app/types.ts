import type {
  Config,
  SiteRule,
  TraceEvent,
  TranslationStyleConfig,
} from "../types";
import type { UsageStore } from "../usage";

export type Theme = "system" | "light" | "dark";
export type SectionId =
  | "service"
  | "reading"
  | "storage"
  | "packs"
  | "diagnostic"
  | "update";

export interface MigrationResultView {
  migratedAt?: string | number;
  time?: number;
  hasKey?: boolean;
  cacheBuckets?: number;
}

export interface SyncStatusView {
  syncedAt?: string;
  revisions?: number;
  packEntries?: number;
  targetUrl?: string;
  error?: string;
}

export type SettingsView = Omit<
  Config,
  "apiKey" | "localToken" | "deeplKey"
> & {
  hasKey: boolean;
  hasLocalToken: boolean;
  hasDeeplKey?: boolean;
  sites?: Record<string, boolean>;
  siteRules?: Record<string, SiteRule>;
  "ui.theme"?: Theme;
  "ui.locale"?: "zh-CN" | "en";
  "ui.progressVisible"?: boolean;
  "ui.translationStyle"?: TranslationStyleConfig;
  "migration.result"?: MigrationResultView;
  "sync.status"?: SyncStatusView;
};

export interface PackView {
  id: string;
  active: number;
  previous: number | null;
  staging: number | null;
  enabled: number;
  priority: number;
  source_lang: string;
  target_lang: string;
  domain: string;
  entries?: number | null;
  raw_bytes?: number | null;
}

export interface CacheStatus {
  packs: PackView[];
  modelEntries: number | null;
  localModelEntries: number | null;
  localModelBytes: number;
  localModelBudgetBytes?: number;
  revisions: number | null;
  dbBytes: number;
  freeBytes: number;
  blockBytes: number | null;
  rawBytes: number | null;
  pending: number;
  pendingBytes: number;
  writeError?: string;
  dirtySince?: number;
  hotBytes: number;
  decodedBytes: number;
  budgetBytes?: number;
  metrics: {
    submittedBytes: number;
    maintenanceBytes: number;
    transactions?: number;
    modelRowsWritten?: number;
  };
}

export interface TracePage {
  events: TraceEvent[];
  hasMore?: boolean;
  stats: {
    pending: number;
    flushes: number;
    diagnosticSubmittedBytes?: number;
    dropped: number;
  };
}

export interface LocalDeploymentItem {
  id: string;
  model: string;
  backend: string;
  state?: string;
  revision?: string;
}

export type UsageStoreView = UsageStore;
