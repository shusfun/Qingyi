import { useEffect, useRef, useState } from "preact/hooks";
import {
  Badge,
  Button,
  Checkbox,
  Disclosure,
  FeedbackBanner,
  IconRefresh,
  SegmentedControl,
  Select,
  SettingGroup,
  SettingRow,
  Switch,
  NumberStepper,
  TextInput,
  confirmAction,
  feedbackStore,
  resolveError,
  runTracked,
  toast,
  useFeedbackStore,
  type FeedbackMessage,
  type UiLang,
} from "../../design-system";
import { singleTextModel } from "../model-profile";
import { DEFAULTS, normalizeLocalOriginUrl } from "../types";
import {
  PROVIDER_PRESETS,
  grantOriginsOnce,
  runTracedUiOp,
  scopedRpc,
} from "./rpc";
import type {
  LocalDeploymentItem,
  SettingsView,
  UsageStoreView,
} from "./types";

export interface ServiceDraft {
  routing: "local-first" | "local-only" | "cloud-only";
  localUrl: string;
  localToken: string;
  clearLocalToken: boolean;
  localModel: string;
  localBackend: "auto" | "cpu" | "cuda" | "metal";
  localAutoStart: boolean;
  localStartupTimeoutSec: string;
  serviceType: "chat" | "deepl";
  apiUrl: string;
  apiKey: string;
  clearKey: boolean;
  deeplUrl: string;
  deeplKey: string;
  clearDeeplKey: boolean;
  model: string;
  intervalSec: string;
  timeoutSec: string;
  concurrency: string;
  batch: boolean;
  dailyRequestLimit: string;
  dailyTokenLimit: string;
  inputPricePerMillion: string;
  outputPricePerMillion: string;
}

export function createServiceDraft(c: SettingsView): ServiceDraft {
  return {
    routing: c.routing || "local-first",
    localUrl: c.localUrl || DEFAULTS.localUrl,
    localToken: "",
    clearLocalToken: false,
    localModel: c.localModel || DEFAULTS.localModel,
    localBackend: c.localBackend || "auto",
    localAutoStart: c.localAutoStart !== false,
    localStartupTimeoutSec: String((c.localStartupTimeoutMs ?? 300000) / 1000),
    serviceType: c.serviceType || "chat",
    apiUrl: c.apiUrl || DEFAULTS.apiUrl,
    apiKey: "",
    clearKey: false,
    deeplUrl: c.deeplUrl || "https://api.deepl.com/v2/translate",
    deeplKey: "",
    clearDeeplKey: false,
    model: c.model || DEFAULTS.model,
    intervalSec: String(c.intervalMs / 1000),
    timeoutSec: String(c.timeoutMs / 1000),
    concurrency: String(c.concurrency),
    batch: Boolean(c.batch),
    dailyRequestLimit: String(c.dailyRequestLimit ?? 0),
    dailyTokenLimit: String(c.dailyTokenLimit ?? 0),
    inputPricePerMillion: String(c.inputPricePerMillion ?? 0),
    outputPricePerMillion: String(c.outputPricePerMillion ?? 0),
  };
}

function localizeDeploymentState(
  state: string | undefined,
  en: boolean,
): string {
  switch (state) {
    case "running":
      return en ? "Running" : "运行中";
    case "loading":
    case "starting":
      return en ? "Loading" : "启动中";
    case "cooldown":
      return en ? "Cooldown" : "冷却中";
    case "failed":
      return en ? "Failed" : "异常";
    case "stopped":
      return en ? "Stopped" : "已停止";
    case "installed":
      return en ? "Installed" : "已安装";
    default:
      return state || (en ? "Unknown" : "未知");
  }
}

export function ServiceSection({
  config,
  draft,
  setDraft,
  dirtySections,
  onReloadAll,
  onSavedConfig,
  lang,
}: {
  config: SettingsView;
  draft: ServiceDraft;
  setDraft: (updater: (prev: ServiceDraft) => ServiceDraft) => void;
  dirtySections: string[];
  onReloadAll: () => Promise<void>;
  onSavedConfig: (next: SettingsView) => void;
  lang: UiLang;
}) {
  const store = useFeedbackStore();
  const en = lang === "en";
  const [deployments, setDeployments] = useState<LocalDeploymentItem[]>([]);
  const [deploymentsNote, setDeploymentsNote] = useState<string>(
    en ? "Deployment list not refreshed yet." : "部署列表尚未刷新。",
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [testBanner, setTestBanner] = useState<FeedbackMessage | null>(null);
  const [pasteBoxOpen, setPasteBoxOpen] = useState(false);
  const [pasteJson, setPasteJson] = useState("");
  const [usage, setUsage] = useState<UsageStoreView | null>(null);
  const testAbortRef = useRef<AbortController | null>(null);

  const loadUsage = async () => {
    try {
      const u = await runTracedUiOp("usage-read", (t) =>
        scopedRpc(t).send<UsageStoreView>("USAGE_READ"),
      );
      setUsage(u);
    } catch {
      // non-fatal
    }
  };

  useEffect(() => {
    void loadUsage();
  }, []);

  // Q-49: Any edit to service fields immediately invalidates stale connection test banner
  const updateField = <K extends keyof ServiceDraft>(
    key: K,
    val: ServiceDraft[K],
  ) => {
    setTestBanner(null);
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
    setDraft((prev) => ({ ...prev, [key]: val }));
  };

  // Validate numeric fields explicitly against empty strings before Number() coercion (Q-28)
  const validateAndBuildPayload = () => {
    const errs: Record<string, string> = {};
    if (
      draft.intervalSec.trim() === "" ||
      !Number.isFinite(Number(draft.intervalSec))
    ) {
      errs.intervalSec = en
        ? "Enter an interval between 0 and 120 seconds."
        : "请填写请求间隔秒数（0–120 秒，不限速请填 0）。";
    } else if (
      Number(draft.intervalSec) < 0 ||
      Number(draft.intervalSec) > 120
    ) {
      errs.intervalSec = en
        ? "Interval must be between 0 and 120 seconds."
        : "请求间隔需在 0–120 秒之间。";
    }

    if (
      draft.timeoutSec.trim() === "" ||
      !Number.isFinite(Number(draft.timeoutSec))
    ) {
      errs.timeoutSec = en
        ? "Enter a timeout between 10 and 180 seconds."
        : "请填写单次超时秒数（10–180 秒）。";
    } else if (
      Number(draft.timeoutSec) < 10 ||
      Number(draft.timeoutSec) > 180
    ) {
      errs.timeoutSec = en
        ? "Timeout must be between 10 and 180 seconds."
        : "单次超时需在 10–180 秒之间。";
    }

    const conc = Number(draft.concurrency);
    if (
      draft.concurrency.trim() === "" ||
      !Number.isInteger(conc) ||
      conc < 1 ||
      conc > 4
    ) {
      errs.concurrency = en
        ? "Concurrency must be an integer from 1 to 4."
        : "并发数需为 1–4 之间的整数。";
    }

    const startupSec = Number(draft.localStartupTimeoutSec);
    if (
      draft.localStartupTimeoutSec.trim() === "" ||
      !Number.isFinite(startupSec) ||
      startupSec < 10 ||
      startupSec > 600
    ) {
      errs.localStartupTimeoutSec = en
        ? "Local cold-start wait must be 10–600 seconds."
        : "本地模型冷启动等待上限需在 10–600 秒之间。";
    }

    if (draft.routing !== "cloud-only" && !draft.localUrl.trim()) {
      errs.localUrl = en
        ? "Enter the local mistral-gui URL."
        : "请填写本地 mistral-gui 管理器地址。";
    }
    if (draft.routing === "cloud-only") {
      const targetUrl =
        draft.serviceType === "deepl" ? draft.deeplUrl : draft.apiUrl;
      if (!targetUrl.trim()) {
        errs[draft.serviceType === "deepl" ? "deeplUrl" : "apiUrl"] = en
          ? "Enter the cloud API endpoint URL."
          : "仅云端模式下请填写云端服务地址。";
      }
    }

    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      throw new Error("INVALID_CONFIG");
    }

    return {
      routing: draft.routing,
      localUrl: normalizeLocalOriginUrl(
        draft.localUrl.trim() || DEFAULTS.localUrl,
      ),
      localToken: draft.localToken,
      clearLocalToken: draft.clearLocalToken,
      localModel: draft.localModel.trim() || DEFAULTS.localModel,
      localBackend: draft.localBackend,
      localAutoStart: draft.localAutoStart,
      localStartupTimeoutMs: Math.round(startupSec * 1000),
      serviceType: draft.serviceType,
      apiUrl: draft.apiUrl.trim() || DEFAULTS.apiUrl,
      apiKey: draft.apiKey,
      clearKey: draft.clearKey,
      deeplUrl: draft.deeplUrl.trim(),
      deeplKey: draft.deeplKey,
      clearDeeplKey: draft.clearDeeplKey,
      model: draft.model.trim() || DEFAULTS.model,
      intervalMs: Math.round(Number(draft.intervalSec) * 1000),
      timeoutMs: Math.round(Number(draft.timeoutSec) * 1000),
      concurrency: conc,
      batch: draft.batch,
      dailyRequestLimit: Math.max(
        0,
        Math.floor(Number(draft.dailyRequestLimit) || 0),
      ),
      dailyTokenLimit: Math.max(
        0,
        Math.floor(Number(draft.dailyTokenLimit) || 0),
      ),
      inputPricePerMillion: Math.max(
        0,
        Number(draft.inputPricePerMillion) || 0,
      ),
      outputPricePerMillion: Math.max(
        0,
        Number(draft.outputPricePerMillion) || 0,
      ),
    };
  };

  // Collect only origins that will actually be contacted, merged into ONE permissions.request (Q-V3, Q-23).
  const collectRequiredOrigins = (
    payload: ReturnType<typeof validateAndBuildPayload>,
  ) => {
    const urls: string[] = [];
    if (payload.routing !== "cloud-only") {
      urls.push(payload.localUrl);
    }
    const cloudConfigured =
      payload.serviceType === "deepl"
        ? Boolean(
            payload.deeplUrl &&
              (payload.deeplKey ||
                (!payload.clearDeeplKey && config.hasDeeplKey)),
          )
        : Boolean(
            payload.apiUrl &&
              (payload.apiKey || (!payload.clearKey && config.hasKey)),
          );
    if (
      payload.routing === "cloud-only" ||
      (payload.routing === "local-first" && cloudConfigured)
    ) {
      const target =
        payload.serviceType === "deepl" ? payload.deeplUrl : payload.apiUrl;
      if (!target.trim()) {
        throw new Error("INVALID_ENDPOINT");
      }
      urls.push(target);
    }
    return urls;
  };

  const handleSave = () =>
    runTracked({ key: "service:save", scope: "service", lang }, async () => {
      const payload = validateAndBuildPayload();
      const origins = collectRequiredOrigins(payload);
      await runTracedUiOp("service-save", async (t) => {
        await grantOriginsOnce(origins, t);
        const rpc = scopedRpc(t);
        await rpc.send("SAVE", { config: payload, trace: t });
        const refreshed = await rpc.send<SettingsView>("PRIVATE");
        onSavedConfig(refreshed);
      });
      toast(
        en
          ? "Service settings saved and verified."
          : "服务配置已保存并回读核对。",
        "success",
      );
    });

  const handleTest = () =>
    runTracked(
      { key: "service:test", scope: "service-test", lang },
      async () => {
        const payload = validateAndBuildPayload();
        const origins = collectRequiredOrigins(payload);
        const ac = new AbortController();
        testAbortRef.current = ac;
        setTestBanner({
          id: "testing",
          tone: "info",
          message: en
            ? "Testing translation service connection…"
            : "正在测试连接与译文校验（如本地模型冷启动可能需要等待）…",
        });
        try {
          const res = await runTracedUiOp("service-test", async (t) => {
            await grantOriginsOnce(origins, t);
            return scopedRpc(t).send<{
              connected: boolean;
              channel?: string;
              localFallbackReason?: string;
              translation?: string;
              sample?: string;
            }>(
              "TEST",
              { config: payload, trace: t },
              { signal: ac.signal, timeoutMs: 185000 },
            );
          });

          const chLabel =
            res.channel === "local"
              ? en
                ? "Local (mistral-gui)"
                : "本地模型（mistral-gui）"
              : payload.serviceType === "deepl"
                ? "DeepL API"
                : en
                  ? "Cloud API"
                  : "云端模型服务";

          // Q-14: Explicitly surface local fallback warning instead of silent green checkmark!
          if (res.localFallbackReason) {
            const resolvedFallback = resolveError(
              res.localFallbackReason,
              lang,
            );
            let managerHref: string | undefined;
            if (
              /LOCAL_HTTP_(401|403)|invalid_token/i.test(
                res.localFallbackReason,
              )
            ) {
              try {
                managerHref = new URL("/manage#instances", payload.localUrl)
                  .href;
              } catch {
                // ignore malformed url
              }
            }
            setTestBanner({
              id: "test-fallback",
              tone: "info",
              message: en
                ? `Cloud fallback succeeded via ${chLabel}, but local model was unavailable: ${resolvedFallback.message}`
                : `已回退至${chLabel}完成校验，但本地模型当前不可用：${resolvedFallback.message}`,
              detail: res.localFallbackReason,
              actionLabel: managerHref
                ? en
                  ? "Open manager connection page"
                  : "打开管理器复制最新 Token"
                : undefined,
              actionHref: managerHref,
            });
          } else {
            setTestBanner({
              id: "test-ok",
              tone: "success",
              message: en
                ? `Connection verified via ${chLabel} (${res.translation || res.sample || "OK"}).`
                : `连接与译文校验通过 · 实际通道：${chLabel}${res.translation || res.sample ? `（示例译文：${res.translation || res.sample}）` : ""}`,
            });
          }
          void loadUsage();
        } catch (err) {
          const resolved = resolveError(err, lang);
          if (resolved.isCancelled) {
            setTestBanner({
              id: "test-cancelled",
              tone: "info",
              message: en ? "Connection test cancelled." : "已取消连接测试。",
            });
            return;
          }
          let managerHref: string | undefined;
          if (/LOCAL_HTTP_(401|403)|invalid_token/i.test(resolved.code)) {
            try {
              managerHref = new URL("/manage#instances", payload.localUrl).href;
            } catch {
              // ignore
            }
          }
          setTestBanner({
            id: "test-err",
            tone: "error",
            message: resolved.message,
            detail: resolved.raw,
            actionLabel: managerHref
              ? en
                ? "Open manager connection page"
                : "打开管理器的部署连接信息"
              : undefined,
            actionHref: managerHref,
          });
        } finally {
          testAbortRef.current = null;
        }
      },
    );

  const handleRefreshDeployments = () =>
    runTracked(
      { key: "service:deployments", scope: "service", lang },
      async () => {
        const cleanUrl = normalizeLocalOriginUrl(
          draft.localUrl.trim() || DEFAULTS.localUrl,
        );
        const list = await runTracedUiOp("refresh-local-models", async (t) => {
          await grantOriginsOnce([cleanUrl], t);
          return scopedRpc(t).send<LocalDeploymentItem[]>("LOCAL_MODELS", {
            config: {
              ...validateAndBuildPayload(),
              localUrl: cleanUrl,
            },
            trace: t,
          });
        });
        setDeployments(list);
        setDeploymentsNote(
          en
            ? `Loaded ${list.length} local deployment(s).`
            : `已读取 ${list.length} 个本地部署；可直接从下拉列表选择或手动输入 ID。`,
        );
        toast(
          en
            ? `Refreshed ${list.length} local deployment(s).`
            : `已刷新 ${list.length} 个本地部署。`,
          "success",
        );
      },
    );

  // M-VD: One-click paste connection JSON from mistral-gui
  const applyPastedManagerConfig = () => {
    try {
      const parsed = JSON.parse(pasteJson.trim());
      if (!parsed || typeof parsed !== "object") {
        throw new Error("INVALID_SETTINGS_IMPORT");
      }
      setTestBanner(null);
      setDraft((prev) => ({
        ...prev,
        routing:
          parsed.routing === "local-only" ||
          parsed.routing === "local-first" ||
          parsed.routing === "cloud-only"
            ? parsed.routing
            : prev.routing === "cloud-only"
              ? "local-first"
              : prev.routing,
        localUrl: parsed.localUrl
          ? normalizeLocalOriginUrl(String(parsed.localUrl))
          : prev.localUrl,
        localToken:
          typeof parsed.localToken === "string" && parsed.localToken.trim()
            ? parsed.localToken.trim()
            : prev.localToken,
        clearLocalToken: false,
        localModel:
          typeof parsed.localModel === "string" && parsed.localModel.trim()
            ? parsed.localModel.trim()
            : prev.localModel,
        localBackend: ["auto", "cpu", "cuda", "metal"].includes(
          parsed.localBackend,
        )
          ? parsed.localBackend
          : prev.localBackend,
        localAutoStart:
          typeof parsed.localAutoStart === "boolean"
            ? parsed.localAutoStart
            : prev.localAutoStart,
      }));
      setPasteJson("");
      setPasteBoxOpen(false);
      toast(
        en
          ? "Filled mistral-gui connection fields. Click Save to apply."
          : "已填入 mistral-gui 连接配置，请点击「保存服务配置」生效。",
        "success",
      );
    } catch (e) {
      feedbackStore.reportError("service", e, lang);
    }
  };

  // Q-52: Keep deployment select and custom text input synchronized!
  const matchedDeployment = deployments.some((d) => d.id === draft.localModel);
  const deploymentSelectValue = matchedDeployment
    ? draft.localModel
    : draft.localModel
      ? "__custom__"
      : "";

  // Q-21: Batch mode only applies when cloud-only AND chat model is not single-segment!
  const isSingleModel = singleTextModel(draft.model);
  const batchEligible =
    draft.routing === "cloud-only" &&
    draft.serviceType === "chat" &&
    !isSingleModel;
  const batchHint = !batchEligible
    ? draft.routing !== "cloud-only"
      ? en
        ? "Disabled: Local-first / Local-only translates per segment so cache & fallback stay isolated. Switch routing to Cloud-only to enable 16-segment batches."
        : "当前未生效（已禁用）：本地优先或仅本地模式按单段调度以保证逐段回退与缓存隔离；切换为「仅云端」且使用非 Hunyuan-MT 对话模型时可开启。"
      : draft.serviceType === "deepl"
        ? en
          ? "DeepL API natively batches paragraphs automatically."
          : "DeepL API 服务原生支持多段数组提交，无需单独开启 JSON 批量模式。"
        : en
          ? "Disabled: Hunyuan-MT uses single-segment prompts per official specification."
          : "当前未生效（已禁用）：Hunyuan-MT 系列模型按官方单段提示词协议翻译。"
    : en
      ? "First visible batch sends up to 4 segments for fast first paint; subsequent batches send up to 16 JSON segments."
      : "首屏视口批次最多 4 段以加快首屏显示，后续批次最多合并 16 段 JSON 请求。";

  const todayKey = new Date().toISOString().slice(0, 10);
  const todayStats = usage?.days?.[todayKey];
  const estimatedCost =
    usage &&
    (usage.totalPromptTokens / 1_000_000) *
      (Number(draft.inputPricePerMillion) || 0) +
      (usage.totalCompletionTokens / 1_000_000) *
        (Number(draft.outputPricePerMillion) || 0);

  const localReady = config.hasLocalToken;
  const cloudReady =
    (config.serviceType || "chat") === "deepl"
      ? Boolean(config.hasDeeplKey)
      : Boolean(config.hasKey);
  const verdictTone =
    config.routing === "local-only"
      ? localReady
        ? "success"
        : "error"
      : config.routing === "cloud-only"
        ? cloudReady
          ? "success"
          : "error"
        : localReady || cloudReady
          ? "success"
          : "neutral";

  return (
    <section class="page panel">
      <FeedbackBanner scope="service" lang={lang} />
      <FeedbackBanner message={testBanner} lang={lang} />

      <SettingGroup
        title={en ? "Routing & Status" : "调用策略"}
        actions={
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <Badge tone={localReady ? "success" : "neutral"}>
              {en
                ? `Local: ${localReady ? "Saved" : "Unset"}`
                : `本地 Token：${localReady ? "已配置" : "未填"}`}
            </Badge>
            <Badge tone={cloudReady ? "success" : "neutral"}>
              {en
                ? `Cloud: ${cloudReady ? "Saved" : "Unset"}`
                : `云端密钥：${cloudReady ? "已配置" : "未填"}`}
            </Badge>
            <span class="hint">
              {en
                ? `Today ${todayStats?.localRequests ?? 0}L / ${todayStats?.cloudRequests ?? 0}C`
                : `今日 ${todayStats?.localRequests ?? 0} 本地 / ${todayStats?.cloudRequests ?? 0} 云端`}
            </span>
          </div>
        }
      >
        <SettingRow
          title={en ? "Translation routing" : "请求路由方式"}
          description={
            draft.routing === "local-only"
              ? en
                ? "Never sends any text to external cloud endpoints."
                : "所有请求仅发往本机 mistral，绝不连接外部云端。"
              : draft.routing === "cloud-only"
                ? en
                  ? "Translates directly via configured cloud service."
                  : "直接使用下方云端翻译服务。"
                : en
                  ? "Uses local mistral first; falls back per-segment to cloud if unavailable."
                  : "优先请求本机 mistral，不可用时按段自动回退云端。"
          }
        >
          <SegmentedControl
            value={draft.routing}
            onChange={(v) => updateField("routing", v)}
            options={[
              {
                value: "local-first",
                label: en ? "Local-first" : "本地优先",
              },
              {
                value: "local-only",
                label: en ? "Local-only" : "仅本地",
              },
              {
                value: "cloud-only",
                label: en ? "Cloud-only" : "仅云端",
              },
            ]}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title={en ? "Local Model (mistral)" : "本地模型（mistral）"}
        actions={
          <>
            <Button size="sm" onClick={() => setPasteBoxOpen((o) => !o)}>
              {en ? "Paste JSON" : "粘贴一键配置"}
            </Button>
            <Button
              size="sm"
              icon={<IconRefresh size={13} />}
              busy={store.isBusy("service:deployments")}
              onClick={handleRefreshDeployments}
            >
              {en ? "Refresh" : "刷新实例"}
            </Button>
          </>
        }
      >
        {pasteBoxOpen ? (
          <SettingRow
            vertical
            title={
              en
                ? "Paste connection JSON from mistral"
                : "粘贴从 mistral「API 与诊断」复制的 JSON"
            }
          >
            <div style={{ display: "flex", gap: "8px", width: "100%" }}>
              <TextInput
                placeholder='{"localUrl":"http://127.0.0.1:19820","localToken":"...","localModel":"..."}'
                value={pasteJson}
                onValueInput={(v) => setPasteJson(v)}
              />
              <Button variant="primary" onClick={applyPastedManagerConfig}>
                {en ? "Apply" : "填入"}
              </Button>
              <Button variant="ghost" onClick={() => setPasteBoxOpen(false)}>
                {en ? "Close" : "收起"}
              </Button>
            </div>
          </SettingRow>
        ) : null}

        <SettingRow
          title={en ? "Manager URL" : "管理器地址"}
          description={
            en ? "Local loopback origin" : "默认 http://127.0.0.1:19820"
          }
          error={fieldErrors.localUrl}
          controlWidth="wide"
        >
          <TextInput
            type="url"
            placeholder="http://127.0.0.1:19820"
            value={draft.localUrl}
            onValueInput={(v) => updateField("localUrl", v)}
          />
        </SettingRow>

        <SettingRow
          title={en ? "Access Token" : "本地访问 Token"}
          description={
            config.hasLocalToken
              ? en
                ? "Saved locally (leave blank to keep)"
                : "已保存（留空保留原值）"
              : en
                ? "Copy from mistral API page"
                : "在 mistral「API 与诊断」复制"
          }
          controlWidth="wide"
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              width: "100%",
            }}
          >
            <TextInput
              type="password"
              autocomplete="new-password"
              placeholder={
                config.hasLocalToken
                  ? en
                    ? "•••••••• (saved)"
                    : "••••••••（已保存）"
                  : en
                    ? "Paste Local Token"
                    : "粘贴本地 Token"
              }
              value={draft.localToken}
              onValueInput={(v) => updateField("localToken", v)}
            />
            {config.hasLocalToken ? (
              <Checkbox
                checked={draft.clearLocalToken}
                onChange={(v) => updateField("clearLocalToken", v)}
                label={en ? "Clear saved Token" : "清除已保存 Token"}
              />
            ) : null}
          </div>
        </SettingRow>

        <SettingRow
          title={en ? "Deployment / Model ID" : "部署实例"}
          description={deploymentsNote}
          error={fieldErrors.localModel}
          controlWidth="wide"
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              width: "100%",
            }}
          >
            {deployments.length > 0 ? (
              <Select
                value={deploymentSelectValue}
                options={[
                  {
                    value: "",
                    label: en ? "Choose discovered…" : "选择已发现实例…",
                  },
                  ...(deploymentSelectValue === "__custom__"
                    ? [
                        {
                          value: "__custom__",
                          label: `${draft.localModel}`,
                        },
                      ]
                    : []),
                  ...deployments.map((d) => ({
                    value: d.id,
                    label: `${d.id} (${localizeDeploymentState(d.state, en)})`,
                  })),
                ]}
                onValueChange={(v) => {
                  if (v && v !== "__custom__") updateField("localModel", v);
                }}
              />
            ) : null}
            <TextInput
              value={draft.localModel}
              onValueInput={(v) => updateField("localModel", v)}
            />
          </div>
        </SettingRow>

        <SettingRow
          title={en ? "Compute backend" : "加速后端"}
          controlWidth="medium"
        >
          <Select
            value={draft.localBackend}
            options={[
              { value: "auto", label: en ? "Follow manager" : "跟随管理器" },
              { value: "cpu", label: "CPU" },
              { value: "cuda", label: "NVIDIA CUDA" },
              { value: "metal", label: "Apple Metal" },
            ]}
            onValueChange={(v) =>
              updateField("localBackend", v as ServiceDraft["localBackend"])
            }
          />
        </SettingRow>

        <SettingRow
          title={en ? "On-demand cold start" : "允许按需冷启动等待"}
          description={
            en
              ? "Wait for model weights to load without failing request timeout."
              : "本地实例未启动时等待加载权重，独立计时不占单次超时。"
          }
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: "145px", maxWidth: "100%" }}>
              <NumberStepper
                en={en}
                name={en ? "Cold start timeout" : "冷启动超时"}
                unit={en ? "s" : "秒"}
                min={10}
                max={600}
                step={10}
                value={draft.localStartupTimeoutSec}
                error={fieldErrors.localStartupTimeoutSec}
                onValueInput={(v) => updateField("localStartupTimeoutSec", v)}
              />
            </div>
            <Switch
              checked={draft.localAutoStart}
              onChange={(v) => updateField("localAutoStart", v)}
            />
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title={en ? "Cloud Service" : "云端翻译服务"}
        actions={
          <div style={{ width: "210px" }}>
            <Select
              value=""
              options={[
                {
                  value: "",
                  label: en ? "Fill from preset…" : "选择服务商预设…",
                },
                ...PROVIDER_PRESETS.map((p) => ({
                  value: p.id,
                  label: en ? p.labelEn : p.labelZh,
                })),
              ]}
              onValueChange={(presetId) => {
                const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
                if (!preset) return;
                setTestBanner(null);
                setDraft((prev) => ({
                  ...prev,
                  serviceType: preset.serviceType,
                  ...(preset.serviceType === "deepl"
                    ? { deeplUrl: preset.url }
                    : { apiUrl: preset.url, model: preset.model }),
                }));
              }}
            />
          </div>
        }
      >
        <SettingRow
          title={en ? "Protocol" : "接口协议"}
          description={
            draft.serviceType === "deepl"
              ? en
                ? "DeepL v2 REST API with XML tag protection"
                : "DeepL 官方翻译接口"
              : en
                ? "OpenAI-compatible /v1/chat/completions"
                : "OpenAI 兼容 Chat Completions 接口"
          }
        >
          <SegmentedControl
            value={draft.serviceType}
            onChange={(v) => updateField("serviceType", v)}
            options={[
              { value: "chat", label: "Chat API" },
              { value: "deepl", label: "DeepL" },
            ]}
          />
        </SettingRow>

        {draft.serviceType === "deepl" ? (
          <>
            <SettingRow
              title={en ? "DeepL Endpoint" : "DeepL 接口地址"}
              error={fieldErrors.deeplUrl}
              controlWidth="wide"
            >
              <TextInput
                type="url"
                placeholder="https://api.deepl.com/v2/translate"
                value={draft.deeplUrl}
                onValueInput={(v) => updateField("deeplUrl", v)}
              />
            </SettingRow>
            <SettingRow
              title="DeepL Auth Key"
              description={
                config.hasDeeplKey
                  ? en
                    ? "Saved (leave blank to keep)"
                    : "已保存（留空保留）"
                  : undefined
              }
              controlWidth="wide"
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  width: "100%",
                }}
              >
                <TextInput
                  type="password"
                  autocomplete="new-password"
                  placeholder={
                    config.hasDeeplKey
                      ? "••••••••"
                      : en
                        ? "Enter DeepL Key"
                        : "输入 DeepL Auth Key"
                  }
                  value={draft.deeplKey}
                  onValueInput={(v) => updateField("deeplKey", v)}
                />
                {config.hasDeeplKey ? (
                  <Checkbox
                    checked={draft.clearDeeplKey}
                    onChange={(v) => updateField("clearDeeplKey", v)}
                    label={en ? "Clear saved Key" : "清除已保存 Key"}
                  />
                ) : null}
              </div>
            </SettingRow>
          </>
        ) : (
          <>
            <SettingRow
              title={en ? "Endpoint URL" : "接口地址"}
              error={fieldErrors.apiUrl}
              controlWidth="wide"
            >
              <TextInput
                type="url"
                autocomplete="off"
                value={draft.apiUrl}
                onValueInput={(v) => updateField("apiUrl", v)}
              />
            </SettingRow>
            <SettingRow
              title="API Key"
              description={
                config.hasKey
                  ? en
                    ? "Saved (leave blank to keep)"
                    : "已保存（留空保留）"
                  : undefined
              }
              controlWidth="wide"
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  width: "100%",
                }}
              >
                <TextInput
                  type="password"
                  autocomplete="new-password"
                  placeholder={
                    config.hasKey
                      ? "••••••••（已保存）"
                      : en
                        ? "Enter API Key"
                        : "输入 API Key"
                  }
                  value={draft.apiKey}
                  onValueInput={(v) => updateField("apiKey", v)}
                />
                {config.hasKey ? (
                  <Checkbox
                    checked={draft.clearKey}
                    onChange={(v) => updateField("clearKey", v)}
                    label={en ? "Clear saved Key" : "清除已保存 Key"}
                  />
                ) : null}
              </div>
            </SettingRow>
            <SettingRow
              title={en ? "Model ID" : "模型名称"}
              description={
                isSingleModel
                  ? en
                    ? "Hunyuan-MT single-segment mode"
                    : "Hunyuan-MT 专用逐段模式"
                  : en
                    ? "Supports JSON batching in Cloud-only mode"
                    : "支持 JSON 批量合并"
              }
              error={fieldErrors.model}
              controlWidth="wide"
            >
              <TextInput
                autocomplete="off"
                value={draft.model}
                onValueInput={(v) => updateField("model", v)}
              />
            </SettingRow>
          </>
        )}
      </SettingGroup>

      <Disclosure
        summary={
          en ? "Concurrency, Timeout & Rate Limits" : "并发、超时与批量策略"
        }
      >
        <div class="grid">
          <NumberStepper
            label={en ? "Min interval (sec)" : "请求间隔（秒）"}
            en={en}
            unit={en ? "s" : "秒"}
            min={0}
            max={120}
            step={0.5}
            value={draft.intervalSec}
            error={fieldErrors.intervalSec}
            onValueInput={(v) => updateField("intervalSec", v)}
          />
          <NumberStepper
            label={en ? "Timeout (sec)" : "单次超时（秒）"}
            en={en}
            unit={en ? "s" : "秒"}
            min={10}
            max={180}
            step={5}
            value={draft.timeoutSec}
            error={fieldErrors.timeoutSec}
            onValueInput={(v) => updateField("timeoutSec", v)}
          />
          <NumberStepper
            label={en ? "Max concurrency (1–4)" : "最大并发数（1–4）"}
            en={en}
            min={1}
            max={4}
            step={1}
            value={draft.concurrency}
            error={fieldErrors.concurrency}
            onValueInput={(v) => updateField("concurrency", v)}
          />
        </div>
        <Switch
          checked={batchEligible && draft.batch}
          disabled={!batchEligible}
          onChange={(v) => updateField("batch", v)}
          label={en ? "JSON Batching" : "开启 JSON 批量合并请求"}
          hint={batchHint}
        />
      </Disclosure>

      <Disclosure
        summary={
          en ? "Usage Stats & Daily Cloud Cap" : "用量统计与每日云端上限"
        }
      >
        <div class="grid">
          <NumberStepper
            label={
              en ? "Daily request cap (0 = off)" : "每日云端请求上限（0 不限）"
            }
            en={en}
            min={0}
            step={10}
            value={draft.dailyRequestLimit}
            onValueInput={(v) => updateField("dailyRequestLimit", v)}
          />
          <NumberStepper
            label={
              en ? "Daily token cap (0 = off)" : "每日云端 Token 上限（0 不限）"
            }
            en={en}
            min={0}
            step={1000}
            value={draft.dailyTokenLimit}
            onValueInput={(v) => updateField("dailyTokenLimit", v)}
          />
          <NumberStepper
            label={en ? "Input price / 1M" : "输入单价 / 百万 Token"}
            en={en}
            min={0}
            step={0.01}
            value={draft.inputPricePerMillion}
            onValueInput={(v) => updateField("inputPricePerMillion", v)}
          />
          <NumberStepper
            label={en ? "Output price / 1M" : "输出单价 / 百万 Token"}
            en={en}
            min={0}
            step={0.01}
            value={draft.outputPricePerMillion}
            onValueInput={(v) => updateField("outputPricePerMillion", v)}
          />
        </div>
        {usage ? (
          <div
            class="split-head"
            style={{
              marginTop: "10px",
              paddingTop: "10px",
              borderTop: "1px solid var(--color-border)",
            }}
          >
            <span class="hint">
              {en
                ? `Cloud ${usage.totalCloudRequests} req · Local ${usage.totalLocalRequests} req · ${(usage.totalPromptTokens + usage.totalCompletionTokens).toLocaleString()} tokens${estimatedCost ? ` · Est. ${estimatedCost.toFixed(4)}` : ""}`
                : `累计：云端 ${usage.totalCloudRequests} 次 · 本地 ${usage.totalLocalRequests} 次 · Token ${(usage.totalPromptTokens + usage.totalCompletionTokens).toLocaleString()}${estimatedCost ? ` · 估算 ${estimatedCost.toFixed(4)}` : ""}`}
            </span>
            <div class="actions" style={{ margin: 0 }}>
              <Button size="sm" onClick={loadUsage}>
                {en ? "Refresh" : "刷新"}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  const ok = await confirmAction({
                    message: en
                      ? "Clear all recorded usage statistics?"
                      : "确定清零本地用量统计吗？",
                    danger: true,
                    lang,
                  });
                  if (!ok) return;
                  await runTracedUiOp("usage-clear", (t) =>
                    scopedRpc(t).send("USAGE_CLEAR"),
                  );
                  await loadUsage();
                  toast(en ? "Usage cleared." : "已清零用量统计。", "success");
                }}
              >
                {en ? "Reset" : "清零"}
              </Button>
            </div>
          </div>
        ) : null}
      </Disclosure>

      <div class="actions" style={{ marginTop: "16px" }}>
        <Button
          variant="primary"
          busy={store.isBusy("service:save")}
          onClick={handleSave}
        >
          {en ? "Save Changes" : "保存配置"}
        </Button>
        <Button busy={store.isBusy("service:test")} onClick={handleTest}>
          {en ? "Test Connection" : "测试连接"}
        </Button>
        {store.isBusy("service:test") ? (
          <Button variant="ghost" onClick={() => testAbortRef.current?.abort()}>
            {en ? "Cancel" : "取消"}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          onClick={async () => {
            if (dirtySections.length > 0) {
              const listText = dirtySections.join(en ? ", " : "、");
              const ok = await confirmAction({
                message: en
                  ? `Discard unsaved edits in ${listText}?`
                  : `放弃未保存的修改（${listText}）并重新读取配置？`,
                lang,
              });
              if (!ok) return;
            }
            await onReloadAll();
            setTestBanner(null);
            setFieldErrors({});
            toast(en ? "Reloaded." : "已重新读取配置。", "info");
          }}
        >
          {en ? "Revert" : "还原已存配置"}
        </Button>
      </div>
    </section>
  );
}
