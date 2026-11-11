import type { Config, TraceEvent } from "../types";
export type Theme = "system" | "light" | "dark";
export type SettingsView = Omit<Config, "apiKey" | "localToken"> & {
  hasKey: boolean;
  hasLocalToken: boolean;
  sites?: Record<string, boolean>;
  "ui.theme"?: Theme;
  "ui.progressVisible"?: boolean;
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
}
export interface CacheStatus {
  packs: PackView[];
  modelEntries: number;
  localModelEntries: number;
  localModelBytes: number;
  revisions: number;
  dbBytes: number;
  freeBytes: number;
  blockBytes: number;
  rawBytes: number;
  pending: number;
  pendingBytes: number;
  writeError?: string;
  hotBytes: number;
  decodedBytes: number;
  metrics: { submittedBytes: number; maintenanceBytes: number };
}
export interface TracePage {
  events: TraceEvent[];
  stats: {
    pending: number;
    flushes: number;
    diagnosticSubmittedBytes?: number;
    dropped: number;
  };
}
