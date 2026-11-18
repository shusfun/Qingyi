import { useRef, useState } from "preact/hooks";
import {
  Badge,
  Button,
  DataList,
  FeedbackBanner,
  TextInput,
  VerdictHero,
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
      <VerdictHero
        eyebrow={en ? "VERSION & PORTABILITY" : "版本检查、配置备份与迁移"}
        title={
          en
            ? `Qingyi Extension v${manifestVersion}`
            : `轻译扩展 v${manifestVersion}`
        }
        description={
          en
            ? `Current update repository: ${config.releaseRepo}`
            : `当前更新发布源：${config.releaseRepo}`
        }
        badge={
          <Badge tone={release?.newer ? "info" : "neutral"}>
            {release?.newer
              ? en
                ? `Update v${release.version}`
                : `可升级 v${release.version}`
              : `v${manifestVersion}`}
          </Badge>
        }
      />

      <fieldset>
        <legend>{en ? "Check for Extension Updates" : "版本更新检查"}</legend>
        <FeedbackBanner scope="update" lang={lang} />
        <FeedbackBanner scope="update-repo" lang={lang} />

        <div class="actions">
          <Button
            variant="primary"
            busy={store.isBusy("update:check")}
            onClick={handleCheckRelease}
          >
            {en ? "Check for updates" : "检查更新"}
          </Button>
        </div>

        {/* Q-36: Structured multi-line release card instead of \n inside <p>! */}
        {release ? (
          <div class="card">
            <div class="split-head">
              <strong>
                {en
                  ? `Current v${release.current} · Latest ${release.tag}`
                  : `当前版本 v${release.current} · 最新版本 ${release.tag}`}
              </strong>
              <Badge tone={release.newer ? "info" : "success"}>
                {release.newer
                  ? en
                    ? "Update available"
                    : "发现新版本"
                  : en
                    ? "Up to date"
                    : "已是最新"}
              </Badge>
            </div>
            <p class="hint">
              {release.hasChecksum
                ? en
                  ? "SHA-256 checksum asset verified."
                  : "已附带 SHA-256 校验文件。"
                : en
                  ? "No SHA-256 checksum file attached."
                  : "未检测到独立的 .sha256 校验文件。"}
            </p>
            {release.notes ? (
              <pre style={{ whiteSpace: "pre-wrap", marginTop: "9px" }}>
                {release.notes}
              </pre>
            ) : null}
            <div class="actions">
              {release.assets.map((asset) => (
                <a
                  key={asset.name}
                  href={asset.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {en
                    ? `Download ${asset.name} (${formatBytes(asset.size, lang)})`
                    : `下载 ${asset.name}（${formatBytes(asset.size, lang)}）`}
                </a>
              ))}
              <a href={release.url} target="_blank" rel="noreferrer">
                {en ? "View release page" : "查看发布页说明"}
              </a>
            </div>
          </div>
        ) : null}

        <TextInput
          label={
            en
              ? "GitHub Release repository (owner/repo)"
              : "更新仓库（owner/repo）"
          }
          value={releaseRepoDraft}
          placeholder={DEFAULTS.releaseRepo}
          onValueInput={(v) => setReleaseRepoDraft(v)}
        />
        <div class="actions">
          <Button
            busy={store.isBusy("update:repo-save")}
            onClick={() => void handleSaveRepo(false)}
          >
            {en ? "Save repository" : "保存更新源"}
          </Button>
          <Button
            busy={store.isBusy("update:repo-reset")}
            onClick={() => void handleSaveRepo(true)}
          >
            {en ? "Restore official repository" : "恢复官方源"}
          </Button>
        </div>
      </fieldset>

      <fieldset>
        <legend>
          {en
            ? "Settings Backup & Import (No Keys)"
            : "配置导出与导入（不含密钥）"}
        </legend>
        <FeedbackBanner scope="settings-io" lang={lang} />
        <p class="hint">
          {en
            ? "Export routing, model names, reading preferences, and site rules to JSON. API keys and local tokens are never exported."
            : "导出调用策略、模型名称、阅读样式与全部网站规则为 JSON 文件；所有 API Key 与本地 Token 均不会导出。导入前会先展示变更差异预览。"}
        </p>
        <div class="actions">
          <Button onClick={handleExportSettings}>
            {en ? "Export settings JSON" : "导出当前配置 JSON"}
          </Button>
          <label
            style={{ display: "inline-flex", alignItems: "center", margin: 0 }}
          >
            <input
              ref={importFileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(e) => void handleSelectSettingsFile(e)}
            />
            <Button onClick={() => importFileRef.current?.click()}>
              {en ? "Import settings JSON…" : "选择配置文件预览导入…"}
            </Button>
          </label>
        </div>

        {pendingImport ? (
          <div class="card">
            <strong>
              {en
                ? `Preview changes (${pendingImport.diffs.length} difference(s))`
                : `导入变更预览（共 ${pendingImport.diffs.length} 项差异）`}
            </strong>
            <DataList
              items={pendingImport.diffs}
              getKey={(d) => d.key}
              emptyMessage={
                en
                  ? "Selected file matches your current settings."
                  : "所选配置文件与当前已保存设置完全一致。"
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
            <div class="actions">
              <Button
                variant="primary"
                busy={store.isBusy("update:import-apply")}
                onClick={handleApplySettingsImport}
              >
                {en ? "Confirm & apply import" : "确认应用导入"}
              </Button>
              <Button variant="ghost" onClick={() => setPendingImport(null)}>
                {en ? "Cancel" : "取消"}
              </Button>
            </div>
          </div>
        ) : null}
      </fieldset>

      <fieldset>
        <legend>
          {en ? "Legacy v2 Data Migration" : "旧版数据一次性迁移"}
        </legend>
        <FeedbackBanner scope="migration" lang={lang} />

        {/* Q-44: Surface persisted migration.result from PRIVATE! */}
        {migrationResult ? (
          <div class="card">
            <p class="muted" style={{ margin: 0 }}>
              {en
                ? `Previous migration record: Key ${migrationResult.hasKey ? "retained" : "not present"}, ${migrationResult.cacheBuckets ?? 0} legacy cache bucket(s)${migrationResult.migratedAt || migrationResult.time ? ` (${new Date((migrationResult.migratedAt || migrationResult.time)!).toLocaleString()})` : ""}.`
                : `历史迁移记录：API Key ${migrationResult.hasKey ? "已保留" : "未包含"} · 迁入旧缓存分区 ${migrationResult.cacheBuckets ?? 0} 个${migrationResult.migratedAt || migrationResult.time ? `（${new Date((migrationResult.migratedAt || migrationResult.time)!).toLocaleString()}）` : ""}。`}
            </p>
          </div>
        ) : null}

        <TextInput
          label={
            en
              ? "6-digit migration code from legacy extension"
              : "旧版扩展生成的 6 位数字迁移码"
          }
          placeholder="000000"
          inputMode="numeric"
          maxLength={6}
          value={migrationCode}
          onValueInput={(v) => setMigrationCode(v.trim())}
        />
        <div class="actions">
          <Button
            busy={store.isBusy("update:migrate")}
            onClick={() => void handleMigrate()}
          >
            {en ? "Migrate legacy data" : "执行旧版迁移"}
          </Button>
        </div>
      </fieldset>
    </section>
  );
}
