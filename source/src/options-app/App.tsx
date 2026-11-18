import { useEffect, useMemo, useState } from "preact/hooks";
import {
  Badge,
  ConfirmHost,
  IconActivity,
  IconBookOpen,
  IconBookmark,
  IconDatabase,
  IconRefresh,
  IconSliders,
  StateBlock,
  ToastViewport,
  feedbackStore,
  normalizeUiLang,
  resolveError,
  type UiLang,
} from "../../design-system";
import { MiB } from "../types";
import { DiagnosticSection } from "./DiagnosticSection";
import { PacksSection } from "./PacksSection";
import { ReadingSection } from "./ReadingSection";
import {
  ServiceSection,
  createServiceDraft,
  type ServiceDraft,
} from "./ServiceSection";
import { StorageSection } from "./StorageSection";
import { UpdateSection } from "./UpdateSection";
import { applyThemeDom, runTracedUiOp, scopedRpc } from "./rpc";
import type { CacheStatus, SectionId, SettingsView } from "./types";

const SECTIONS: {
  id: SectionId;
  zhTitle: string;
  enTitle: string;
  zhSummary: string;
  enSummary: string;
}[] = [
  {
    id: "service",
    zhTitle: "翻译服务",
    enTitle: "Translation Service",
    zhSummary: "选择文字的去向，保留阅读的节奏。",
    enSummary:
      "Configure local mistral-gui routing, cloud fallback, and rate caps.",
  },
  {
    id: "reading",
    zhTitle: "阅读与网站",
    enTitle: "Reading & Websites",
    zhSummary: "让翻译按你的阅读习惯出现。",
    enSummary:
      "Customize target language, bilingual layout, site rules, and PDF reader.",
  },
  {
    id: "storage",
    zhTitle: "本地缓存",
    enTitle: "Local Cache",
    zhSummary: "查看空间与写回状态，按需维护。",
    enSummary: "Inspect SQLite / OPFS storage health, budget, and maintenance.",
  },
  {
    id: "packs",
    zhTitle: "词库与修订",
    enTitle: "Dictionaries & Revisions",
    zhSummary: "让可靠的译文在下一次阅读中直接复用。",
    enSummary:
      "Manage offline dictionary packs, user revisions, and desktop sync.",
  },
  {
    id: "diagnostic",
    zhTitle: "诊断",
    enTitle: "Diagnostics",
    zhSummary: "从一次操作追溯结果，按需展开技术详情。",
    enSummary:
      "Inspect redacted W3C trace records and export diagnostic bundles.",
  },
  {
    id: "update",
    zhTitle: "更新与迁移",
    enTitle: "Updates & Portability",
    zhSummary: "检查版本，导出备份或迁入旧版数据。",
    enSummary:
      "Check releases, import/export settings JSON, or migrate legacy data.",
  },
];

function parseHashRoute(): { section: SectionId; notice?: string } {
  const full = location.hash.replace(/^#/, "");
  const [rawId, query = ""] = full.split("?", 2);
  const params = new URLSearchParams(query);
  const notice = params.get("notice") || undefined;
  if (rawId === "reading-file-access") {
    return { section: "reading", notice };
  }
  const matched = SECTIONS.some((s) => s.id === rawId)
    ? (rawId as SectionId)
    : "service";
  return { section: matched, notice };
}

export function App() {
  const [section, setSection] = useState<SectionId>(
    () => parseHashRoute().section,
  );
  const [config, setConfig] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{
    message: string;
    detail?: string;
  } | null>(null);

  // Controlled drafts across sections so unsaved changes are tracked accurately (Q-33, Q-34)
  const [serviceDraft, setServiceDraft] = useState<ServiceDraft | null>(null);
  const [budgetDraftGiB, setBudgetDraftGiB] = useState("4");
  const [savedPackUrl, setSavedPackUrl] = useState("");
  const [packUrlDraft, setPackUrlDraft] = useState("");
  const [releaseRepoDraft, setReleaseRepoDraft] = useState("");

  // Shared SQLite cache status for Storage & Packs sections
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);

  const lang: UiLang = normalizeUiLang(config?.["ui.locale"] || "zh-CN");
  const en = lang === "en";

  const version =
    typeof chrome !== "undefined" && chrome.runtime?.getManifest
      ? chrome.runtime.getManifest().version
      : "3.1.1";

  const resetDraftsFromConfig = (c: SettingsView, packUrlVal?: string) => {
    setConfig(c);
    applyThemeDom(c["ui.theme"] || "system");
    document.documentElement.lang = c["ui.locale"] === "en" ? "en" : "zh-CN";
    setServiceDraft(createServiceDraft(c));
    setBudgetDraftGiB(String(c.budgetBytes / (1024 * MiB)));
    setReleaseRepoDraft(c.releaseRepo || "");
    if (packUrlVal !== undefined) {
      setSavedPackUrl(packUrlVal);
      setPackUrlDraft(packUrlVal);
    }
  };

  const loadInitial = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      await runTracedUiOp("settings-load", async (t) => {
        const rpc = scopedRpc(t);
        const priv = await rpc.send<SettingsView>("PRIVATE");
        const stored = await chrome.storage.local.get("pack.source");
        resetDraftsFromConfig(priv, String(stored["pack.source"] || ""));
      });
    } catch (err) {
      const resolved = resolveError(err, lang);
      setLoadError({ message: resolved.message, detail: resolved.raw });
    } finally {
      setLoading(false);
    }
  };

  const refreshCacheStatus = async () => {
    try {
      const s = await runTracedUiOp("cache-status", (t) =>
        scopedRpc(t).db<CacheStatus>("status"),
      );
      setCacheStatus(s);
      setCacheError(null);
    } catch (err) {
      const resolved = resolveError(err, lang);
      setCacheError(resolved.raw || resolved.message);
      throw err;
    }
  };

  useEffect(() => {
    void loadInitial();
    const syncFromHash = () => {
      const parsed = parseHashRoute();
      setSection(parsed.section);
      if (parsed.notice) {
        const resolved = resolveError(parsed.notice, lang);
        feedbackStore.setBanner(parsed.section, {
          tone: "warning",
          message: resolved.message,
        });
      }
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  // Compute exact dirty section names (Q-33)
  const dirtySections = useMemo(() => {
    if (!config || !serviceDraft) return [];
    const out: string[] = [];
    const baselineService = createServiceDraft(config);
    if (JSON.stringify(serviceDraft) !== JSON.stringify(baselineService)) {
      out.push(en ? "Translation Service" : "翻译服务");
    }
    if (budgetDraftGiB !== String(config.budgetBytes / (1024 * MiB))) {
      out.push(en ? "Local Cache" : "本地缓存");
    }
    if (packUrlDraft !== savedPackUrl) {
      out.push(en ? "Dictionaries & Revisions" : "词库与修订");
    }
    if (releaseRepoDraft !== (config.releaseRepo || "")) {
      out.push(en ? "Updates & Portability" : "更新与迁移");
    }
    return out;
  }, [
    config,
    serviceDraft,
    budgetDraftGiB,
    packUrlDraft,
    savedPackUrl,
    releaseRepoDraft,
    en,
  ]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtySections.length > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtySections.length]);

  const activeMeta = SECTIONS.find((s) => s.id === section) || SECTIONS[0];

  const sectionIcon = (id: SectionId) => {
    switch (id) {
      case "service":
        return <IconSliders size={16} />;
      case "reading":
        return <IconBookOpen size={16} />;
      case "storage":
        return <IconDatabase size={16} />;
      case "packs":
        return <IconBookmark size={16} />;
      case "diagnostic":
        return <IconActivity size={16} />;
      case "update":
        return <IconRefresh size={16} />;
    }
  };

  return (
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href="#service">
          <img src="./icons/logo.svg" alt="" />
          <span>{en ? "Qingyi" : "轻译"}</span>
        </a>
        <nav aria-label={en ? "Settings navigation" : "设置导航"}>
          {SECTIONS.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              aria-current={section === item.id ? "page" : undefined}
            >
              {sectionIcon(item.id)}
              <span>{en ? item.enTitle : item.zhTitle}</span>
            </a>
          ))}
        </nav>
        <footer>v{version}</footer>
      </aside>

      <div class="shell-scroll">
        <main>
          <header>
            <h1>{en ? activeMeta.enTitle : activeMeta.zhTitle}</h1>
            {dirtySections.length > 0 ? (
              <Badge tone="info">
                {en
                  ? `Unsaved (${dirtySections.join(", ")})`
                  : `未保存：${dirtySections.join("、")}`}
              </Badge>
            ) : null}
          </header>

          {loading ? (
            <StateBlock
              kind="loading"
              title={en ? "Loading settings…" : "正在读取配置…"}
              message={
                en
                  ? "Connecting to Qingyi background service."
                  : "正在读取本地配置…"
              }
              lang={lang}
            />
          ) : loadError || !config || !serviceDraft ? (
            <StateBlock
              kind="failed"
              title={en ? "Failed to load settings" : "配置读取未成功"}
              message={
                loadError?.message ||
                (en
                  ? "Unable to contact extension background worker."
                  : "无法连接后台服务，表单已暂时锁定。")
              }
              detail={loadError?.detail}
              onRetry={() => void loadInitial()}
              lang={lang}
            />
          ) : (
            <div key={section} class="page-enter">
              {section === "service" ? (
                <ServiceSection
                  config={config}
                  draft={serviceDraft}
                  setDraft={(updater) =>
                    setServiceDraft((prev) => (prev ? updater(prev) : prev))
                  }
                  dirtySections={dirtySections}
                  onReloadAll={loadInitial}
                  onSavedConfig={(next) => {
                    setConfig(next);
                    setServiceDraft(createServiceDraft(next));
                  }}
                  lang={lang}
                />
              ) : section === "reading" ? (
                <ReadingSection
                  config={config}
                  onSavedConfig={(next) => {
                    setConfig(next);
                    applyThemeDom(next["ui.theme"] || "system");
                    document.documentElement.lang =
                      next["ui.locale"] === "en" ? "en" : "zh-CN";
                  }}
                  lang={lang}
                />
              ) : section === "storage" ? (
                <StorageSection
                  config={config}
                  budgetDraftGiB={budgetDraftGiB}
                  setBudgetDraftGiB={setBudgetDraftGiB}
                  cacheStatus={cacheStatus}
                  cacheError={cacheError}
                  onRefreshCache={refreshCacheStatus}
                  onSavedConfig={(next) => {
                    setConfig(next);
                    setBudgetDraftGiB(String(next.budgetBytes / (1024 * MiB)));
                  }}
                  lang={lang}
                />
              ) : section === "packs" ? (
                <PacksSection
                  config={config}
                  packUrlDraft={packUrlDraft}
                  setPackUrlDraft={setPackUrlDraft}
                  onSavedPackUrl={(u) => {
                    setSavedPackUrl(u);
                    setPackUrlDraft(u);
                  }}
                  cacheStatus={cacheStatus}
                  onRefreshCache={refreshCacheStatus}
                  onSavedConfig={(next) => setConfig(next)}
                  lang={lang}
                />
              ) : section === "diagnostic" ? (
                <DiagnosticSection lang={lang} />
              ) : (
                <UpdateSection
                  config={config}
                  releaseRepoDraft={releaseRepoDraft}
                  setReleaseRepoDraft={setReleaseRepoDraft}
                  dirtySections={dirtySections}
                  onSavedConfig={(next) => {
                    setConfig(next);
                    setReleaseRepoDraft(next.releaseRepo || "");
                  }}
                  onResetAllDrafts={(next) => resetDraftsFromConfig(next)}
                  onRefreshCache={refreshCacheStatus}
                  lang={lang}
                />
              )}
            </div>
          )}
        </main>
      </div>

      <ConfirmHost lang={lang} />
      <ToastViewport />
    </div>
  );
}
