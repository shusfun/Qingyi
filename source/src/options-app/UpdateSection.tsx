import { useRef, useState } from "preact/hooks";
import {
  Badge,
  Button,
  DataList,
  Disclosure,
  FeedbackBanner,
  IconDownload,
  IconRefresh,
  IconUpload,
  SettingGroup,
  SettingRow,
  TextInput,
  confirmAction,
  feedbackStore,
  formatBytes,
  runTracked,
  toast,
  useFeedbackStore,
  type UiLang,
} from "../../design-system";
import type { ReleaseInfo } from "../releases";
import { DEFAULTS } from "../types";
import { runTracedUiOp, scopedRpc } from "./rpc";
import type { SettingsView } from "./types";

interface ExportedSettingsBundle {
  format: "qingyi-settings-v1";
  exportedAt: string;
  config: Record<string, unknown>;
  preferences: Record<string, unknown>;
  siteRules: Record<string, unknown>;
}

const EXPORTABLE_CONFIG_KEYS = [
  "apiUrl",
  "model",
  "intervalMs",
  "timeoutMs",
  "concurrency",
  "mode",
  "batch",
  "budgetBytes",
  "releaseRepo",
  "routing",
  "localUrl",
  "localModel",
  "localBackend",
  "localAutoStart",
  "localStartupTimeoutMs",
  "targetLang",
  "translateAttributes",
  "serviceType",
  "deeplUrl",
  "syncDictionary",
  "dailyRequestLimit",
  "dailyTokenLimit",
  "inputPricePerMillion",
  "outputPricePerMillion",
] as const;

export function UpdateSection({
  config,
  releaseRepoDraft,
  setReleaseRepoDraft,
  dirtySections,
  onSavedConfig,
  onResetAllDrafts,
  onRefreshCache,
  lang,
}: {
  config: SettingsView;
  releaseRepoDraft: string;
  setReleaseRepoDraft: (v: string) => void;
  dirtySections: string[];
  onSavedConfig: (next: SettingsView) => void;
  onResetAllDrafts: (next: SettingsView) => void;
  onRefreshCache: () => Promise<void>;
  lang: UiLang;
}) {
  const store = useFeedbackStore();
  const en = lang === "en";

  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [migrationCode, setMigrationCode] = useState("");
  const importFileRef = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<{
    bundle: ExportedSettingsBundle;
    diffs: { key: string; before: string; after: string }[];
  } | null>(null);

  const manifestVersion =
    typeof chrome !== "undefined" && chrome.runtime?.getManifest
      ? chrome.runtime.getManifest().version
      : "3.1.1";

  const migrationResult = config["migration.result"];

  const handleCheckRelease = () =>
    runTracked({ key: "update:check", scope: "update", lang }, async () => {
      feedbackStore.setBanner("update", {
        tone: "info",
        message: en
          ? "Checking GitHub Releases…"
          : "正在向更新源查询最新发布版本…",
        autoDismissMs: 0,
      });
      const r = await runTracedUiOp("release-check", (t) =>
        scopedRpc(t).send<ReleaseInfo>("RELEASE"),
      );
      setRelease(r);
      feedbackStore.setBanner("update", {
        tone: r.newer ? "info" : "success",
        message: r.newer
          ? en
            ? `New version ${r.version} available (current: ${r.current}).`
            : `发现新版本 v${r.version}（当前版本 v${r.current}）。`
          : en
            ? `You are on the latest version (v${r.current}).`
            : `当前已是最新版本（v${r.current}）。`,
      });
    });

  // Q-35: Accurate error mapping via unified feedbackStore.reportError (no false "network error" fallback!)
  const handleSaveRepo = (resetToOfficial: boolean) =>
    runTracked(
      {
        key: resetToOfficial ? "update:repo-reset" : "update:repo-save",
        scope: "update-repo",
        lang,
      },
      async () => {
        const value = resetToOfficial
          ? DEFAULTS.releaseRepo
          : releaseRepoDraft.trim() || DEFAULTS.releaseRepo;
        await runTracedUiOp("release-repo-save", async (t) => {
          const rpc = scopedRpc(t);
          await rpc.send("SAVE", { config: { releaseRepo: value }, trace: t });
          const next = await rpc.send<SettingsView>("PRIVATE");
          onSavedConfig(next);
          setReleaseRepoDraft(next.releaseRepo);
        });
        toast(
          resetToOfficial
            ? en
              ? "Restored official update repository."
              : "已恢复官方更新源。"
            : en
              ? "Saved update repository."
              : "更新源已保存。",
          "success",
        );
      },
    );

  // Settings Export (never exports keys/tokens!) & Import with diff preview (Prompt Item 13)
  const handleExportSettings = () => {
    const cleanConfig: Record<string, unknown> = {};
    for (const k of EXPORTABLE_CONFIG_KEYS) {
      if ((config as any)[k] !== undefined) {
        cleanConfig[k] = (config as any)[k];
      }
    }
    const bundle: ExportedSettingsBundle = {
      format: "qingyi-settings-v1",
      exportedAt: new Date().toISOString(),
      config: cleanConfig,
      preferences: {
        theme: config["ui.theme"] || "system",
        locale: config["ui.locale"] || "zh-CN",
        progressVisible: config["ui.progressVisible"] !== false,
        translationStyle: config["ui.translationStyle"] || undefined,
      },
      siteRules: config.siteRules || {},
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qingyi-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(
      en
        ? "Exported settings JSON (API keys and tokens excluded)."
        : "已导出设置 JSON（已自动排除所有 API Key 与本地 Token）。",
      "success",
    );
  };

  const handleSelectSettingsFile = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as ExportedSettingsBundle;
      if (
        !parsed ||
        parsed.format !== "qingyi-settings-v1" ||
        typeof parsed.config !== "object"
      ) {
        throw new Error("INVALID_SETTINGS_IMPORT");
      }
      // Strip any accidentally hand-added secret fields
      delete (parsed.config as any).apiKey;
      delete (parsed.config as any).localToken;
      delete (parsed.config as any).deeplKey;

      const diffs: { key: string; before: string; after: string }[] = [];
      for (const k of EXPORTABLE_CONFIG_KEYS) {
        if (k in parsed.config) {
          const b = JSON.stringify((config as any)[k]);
          const a = JSON.stringify((parsed.config as any)[k]);
          if (b !== a) {
            diffs.push({ key: k, before: b ?? "—", after: a ?? "—" });
          }
        }
      }
      const oldSiteCount = Object.keys(config.siteRules || {}).length;
      const newSiteCount = Object.keys(parsed.siteRules || {}).length;
      if (
        JSON.stringify(config.siteRules || {}) !==
        JSON.stringify(parsed.siteRules || {})
      ) {
        diffs.push({
          key: "siteRules",
          before: `${oldSiteCount} site(s)`,
          after: `${newSiteCount} site(s)`,
        });
      }
      setPendingImport({ bundle: parsed, diffs });
    } catch (err) {
      feedbackStore.reportError("settings-io", err, lang);
    } finally {
      if (importFileRef.current) importFileRef.current.value = "";
    }
  };

  const handleApplySettingsImport = () =>
    runTracked(
      { key: "update:import-apply", scope: "settings-io", lang },
      async () => {
        if (!pendingImport) return;
        const { bundle } = pendingImport;
        await runTracedUiOp("settings-import", async (t) => {
          const rpc = scopedRpc(t);
          await rpc.send("SAVE", { config: bundle.config, trace: t });
          if (bundle.preferences) {
            await rpc.send("PREFERENCES", {
              theme: bundle.preferences.theme,
              locale: bundle.preferences.locale,
              visible: bundle.preferences.progressVisible,
              translationStyle: bundle.preferences.translationStyle,
            });
          }
          if (bundle.siteRules && typeof bundle.siteRules === "object") {
            for (const [origin, rule] of Object.entries(bundle.siteRules)) {
              await rpc.send("SAVE_SITE_RULE", { origin, rule });
            }
          }
          const next = await rpc.send<SettingsView>("PRIVATE");
          onResetAllDrafts(next);
        });
        setPendingImport(null);
        toast(
          en
            ? "Settings imported and applied."
            : "已导入并应用设置项（已有密钥保持不变）。",
          "success",
        );
      },
    );

  // Q-34 & Q-44: Warn if drafts exist, discard conflicting drafts on migration success, and display persisted migration.result!
  const handleMigrate = async () => {
    if (dirtySections.length > 0) {
      const ok = await confirmAction({
        message: en
          ? `Migrating legacy data will overwrite unsaved edits in: ${dirtySections.join(", ")}. Continue?`
          : `执行旧版迁移将覆盖当前尚未保存的表单草稿（${dirtySections.join("、")}）。确定继续吗？`,
        lang,
      });
      if (!ok) return;
    }
    await runTracked(
      { key: "update:migrate", scope: "migration", lang },
      async () => {
        const res = await runTracedUiOp("legacy-migrate", async (t) => {
          const rpc = scopedRpc(t);
          const out = await rpc.send<{
            hasKey: boolean;
            cacheBuckets: number;
          }>("MIGRATE", { code: migrationCode });
          const next = await rpc.send<SettingsView>("PRIVATE");
          onResetAllDrafts(next);
          await onRefreshCache();
          return out;
        });
        setMigrationCode("");
        feedbackStore.setBanner("migration", {
          tone: "success",
          message: en
            ? `Migrated successfully (Key ${res.hasKey ? "retained" : "unset"}, ${res.cacheBuckets} legacy cache bucket(s)). Re-save Service settings to authorize API domain.`
            : `旧版数据已迁移完成：API Key ${res.hasKey ? "已保留" : "未配置"}，共迁入 ${res.cacheBuckets} 个旧缓存分区。请前往「翻译服务」点击保存以完成域名授权。`,
        });
      },
    );
  };

  return (
    <section class="page panel">
      <FeedbackBanner scope="update" lang={lang} />
      <FeedbackBanner scope="update-repo" lang={lang} />
      <FeedbackBanner scope="settings-io" lang={lang} />
      <FeedbackBanner scope="migration" lang={lang} />

      <SettingGroup title={en ? "Version & Updates" : "版本与更新"}>
        <SettingRow
          title={en ? "Current Version" : "当前扩展版本"}
          description={`${config.releaseRepo}`}
        >
          <Badge tone={release?.newer ? "info" : "neutral"}>
            {release?.newer
              ? en
                ? `New v${release.version}`
                : `可升级 v${release.version}`
              : `v${manifestVersion}`}
          </Badge>
          <Button
            variant="primary"
            size="sm"
            icon={<IconRefresh size={13} />}
            busy={store.isBusy("update:check")}
            onClick={handleCheckRelease}
          >
            {en ? "Check Updates" : "检查更新"}
          </Button>
        </SettingRow>

        {release ? (
          <SettingRow
            vertical
            title={
              en
                ? `Latest Release: ${release.tag}`
                : `最新发布版本：${release.tag}`
            }
            description={
              release.hasChecksum
                ? en
                  ? "SHA-256 checksum verified"
                  : "已附带 SHA-256 校验摘要"
                : undefined
            }
          >
            {release.notes ? (
              <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                {release.notes}
              </pre>
            ) : null}
            <div class="actions" style={{ margin: 0 }}>
              {release.assets.map((asset) => (
                <a
                  key={asset.name}
                  class="button sm"
                  href={asset.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {`${asset.name} (${formatBytes(asset.size, lang)})`}
                </a>
              ))}
              <a
                class="button ghost sm"
                href={release.url}
                target="_blank"
                rel="noreferrer"
              >
                {en ? "Release notes ↗" : "发布说明 ↗"}
              </a>
            </div>
          </SettingRow>
        ) : null}

        <SettingRow
          title={en ? "Release Repository" : "更新发布仓库"}
          description={en ? "GitHub owner/repo" : "留空恢复官方仓库"}
        >
          <div style={{ width: "180px" }}>
            <TextInput
              value={releaseRepoDraft}
              placeholder={DEFAULTS.releaseRepo}
              onValueInput={(v) => setReleaseRepoDraft(v)}
            />
          </div>
          <Button
            size="sm"
            busy={store.isBusy("update:repo-save")}
            onClick={() => void handleSaveRepo(false)}
          >
            {en ? "Save" : "保存"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            busy={store.isBusy("update:repo-reset")}
            onClick={() => void handleSaveRepo(true)}
          >
            {en ? "Reset" : "恢复官方"}
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={en ? "Settings Backup" : "配置备份与导入"}>
        <SettingRow
          title={en ? "Export & Import JSON" : "导出或导入配置（不含密钥）"}
          description={
            en
              ? "Includes routing, models, reading style, and per-site rules."
              : "包含策略、模型名、阅读样式与网站规则；导入前展示差异确认。"
          }
        >
          <Button
            size="sm"
            icon={<IconDownload size={13} />}
            onClick={handleExportSettings}
          >
            {en ? "Export JSON" : "导出配置"}
          </Button>
          <input
            ref={importFileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => void handleSelectSettingsFile(e)}
          />
          <Button
            size="sm"
            icon={<IconUpload size={13} />}
            onClick={() => importFileRef.current?.click()}
          >
            {en ? "Import JSON…" : "导入配置…"}
          </Button>
        </SettingRow>

        {pendingImport ? (
          <SettingRow
            vertical
            title={
              en
                ? `Import Preview (${pendingImport.diffs.length} change(s))`
                : `变更预览（${pendingImport.diffs.length} 项差异）`
            }
          >
            <DataList
              items={pendingImport.diffs}
              getKey={(d) => d.key}
              emptyMessage={
                en
                  ? "No differences from current settings."
                  : "与当前配置完全一致。"
              }
              lang={lang}
              renderItem={(d) => (
                <div class="list-row-main">
                  <strong>
                    <code>{d.key}</code>
                  </strong>
                  <p class="hint">
                    {d.before} → <strong>{d.after}</strong>
                  </p>
                </div>
              )}
            />
            <div class="actions" style={{ margin: 0 }}>
              <Button
                variant="primary"
                size="sm"
                busy={store.isBusy("update:import-apply")}
                onClick={handleApplySettingsImport}
              >
                {en ? "Apply Import" : "确认导入"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPendingImport(null)}
              >
                {en ? "Cancel" : "取消"}
              </Button>
            </div>
          </SettingRow>
        ) : null}
      </SettingGroup>

      <Disclosure
        summary={en ? "Legacy v2 Data Migration" : "旧版 2.x 数据迁移"}
      >
        {migrationResult ? (
          <p class="hint" style={{ marginBottom: "10px" }}>
            {en
              ? `Last migration: Key ${migrationResult.hasKey ? "retained" : "unset"}, ${migrationResult.cacheBuckets ?? 0} bucket(s).`
              : `上次迁移：API Key ${migrationResult.hasKey ? "已保留" : "未含"} · 旧缓存分区 ${migrationResult.cacheBuckets ?? 0} 个。`}
          </p>
        ) : null}
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <div style={{ width: "160px" }}>
            <TextInput
              placeholder={en ? "6-digit code" : "6 位迁移验证码"}
              inputMode="numeric"
              maxLength={6}
              value={migrationCode}
              onValueInput={(v) => setMigrationCode(v.trim())}
            />
          </div>
          <Button
            busy={store.isBusy("update:migrate")}
            onClick={() => void handleMigrate()}
          >
            {en ? "Migrate" : "执行迁移"}
          </Button>
        </div>
      </Disclosure>
    </section>
  );
}
