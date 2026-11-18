import { useEffect, useRef, useState } from "preact/hooks";
import {
  Badge,
  Button,
  Checkbox,
  Disclosure,
  FeedbackBanner,
  Select,
  Switch,
  TextInput,
  VerdictHero,
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
      <VerdictHero
        eyebrow={en ? "ROUTING & CREDENTIALS" : "当前服务状态"}
        title={
          config.routing === "local-only"
            ? localReady
              ? en
                ? "Local-only mode · Connected to mistral-gui"
                : "仅本地推理就绪 · 不向外部发送原文"
              : en
                ? "Local-only mode · Local Token required"
                : "仅本地模式 · 尚未配置本地管理器 Token"
            : config.routing === "cloud-only"
              ? cloudReady
                ? en
                  ? "Cloud-only mode · Ready"
                  : "仅云端服务就绪"
                : en
                  ? "Cloud-only mode · API Key not configured"
                  : "仅云端模式 · 尚未保存云端 API Key（仅离线词库可用）"
              : localReady && cloudReady
                ? en
                  ? "Local-first with Cloud fallback · Both channels configured"
                  : "本地优先，失败自动回退云端 · 双通道凭据均已就绪"
                : localReady
                  ? en
                    ? "Local-first · Local Token saved (Cloud key unset)"
                    : "本地优先 · 本地 Token 已配置（云端 Key 未填，本地失败将报错而非回退）"
                  : cloudReady
                    ? en
                      ? "Local-first · Using Cloud fallback until Local Token is set"
                      : "本地优先 · 本地 Token 未填，当前将回退使用云端服务"
                    : en
                      ? "Dictionary-only · Configure Local Token or Cloud Key to translate new text"
                      : "当前仅离线词库生效 · 配置本地 Token 或云端 Key 后可翻译新段落"
        }
        tone={verdictTone}
        badge={
          <Badge tone={verdictTone}>
            {config.routing === "local-only"
              ? en
                ? "Local Only"
                : "仅本地"
              : config.routing === "cloud-only"
                ? en
                  ? "Cloud Only"
                  : "仅云端"
                : en
                  ? "Local First"
                  : "本地优先"}
          </Badge>
        }
        metrics={[
          {
            label: en ? "Local Token" : "本地 Token",
            value: config.hasLocalToken
              ? en
                ? "Saved"
                : "已保存"
              : en
                ? "Not set"
                : "未配置",
          },
          {
            label: en ? "Cloud Credential" : "云端密钥",
            value: cloudReady
              ? en
                ? "Saved"
                : "已保存"
              : en
                ? "Not set"
                : "未配置",
          },
          {
            label: en ? "Today Cloud / Local" : "今日请求（云端 / 本地）",
            value: `${todayStats?.cloudRequests ?? 0} / ${todayStats?.localRequests ?? 0}`,
          },
        ]}
      />

      <FeedbackBanner scope="service" lang={lang} />
      <FeedbackBanner message={testBanner} lang={lang} />

      <Select
        label={en ? "Routing policy" : "调用策略"}
        value={draft.routing}
        options={[
          {
            value: "local-first",
            label: en
              ? "Local-first, fall back to Cloud on failure"
              : "本地优先，失败回退云端",
          },
          {
            value: "local-only",
            label: en
              ? "Local-only (never contact Cloud)"
              : "仅本地（绝不请求云端）",
          },
          {
            value: "cloud-only",
            label: en ? "Cloud-only" : "仅云端",
          },
        ]}
        onValueChange={(v) =>
          updateField("routing", v as ServiceDraft["routing"])
        }
      />

      <fieldset>
        <legend>
          {en ? "mistral-gui Local Model" : "mistral-gui 本地模型"}
        </legend>
        <div class="actions">
          <Button onClick={() => setPasteBoxOpen((o) => !o)}>
            {en
              ? "Paste config from mistral-gui"
              : "粘贴 mistral-gui 一键连接配置"}
          </Button>
          <Button
            busy={store.isBusy("service:deployments")}
            onClick={handleRefreshDeployments}
          >
            {en ? "Refresh local deployments" : "刷新本地部署列表"}
          </Button>
        </div>

        {pasteBoxOpen ? (
          <div class="card">
            <TextInput
              label={
                en
                  ? "Paste JSON copied from mistral-gui Overview / API page"
                  : "粘贴从 mistral-gui「概览」或「连接与集成」复制的 JSON"
              }
              placeholder='{"localUrl":"http://127.0.0.1:19820","localToken":"...","localModel":"..."}'
              value={pasteJson}
              onValueInput={(v) => setPasteJson(v)}
            />
            <div class="actions">
              <Button onClick={applyPastedManagerConfig}>
                {en ? "Fill fields" : "填入表单"}
              </Button>
              <Button variant="ghost" onClick={() => setPasteBoxOpen(false)}>
                {en ? "Cancel" : "收起"}
              </Button>
            </div>
          </div>
        ) : null}

        <div class="grid">
          <TextInput
            label={en ? "Manager origin URL" : "管理器地址"}
            type="url"
            placeholder="http://127.0.0.1:19820"
            value={draft.localUrl}
            error={fieldErrors.localUrl}
            hint={
              en
                ? "Loopback origin without /v1 (any trailing /v1 is stripped automatically)."
                : "填写本机回环地址（若带 /v1 会自动规范化去除）。"
            }
            onValueInput={(v) => updateField("localUrl", v)}
          />
          <TextInput
            label={en ? "Local Token" : "本地 Token"}
            type="password"
            autocomplete="new-password"
            placeholder={
              config.hasLocalToken
                ? en
                  ? "Leave blank to keep saved Token"
                  : "留空保留已保存的 Token"
                : en
                  ? "Paste Token from mistral-gui"
                  : "粘贴 mistral-gui 中的连接 Token"
            }
            value={draft.localToken}
            onValueInput={(v) => updateField("localToken", v)}
          />
        </div>

        <Checkbox
          checked={draft.clearLocalToken}
          onChange={(v) => updateField("clearLocalToken", v)}
          label={en ? "Remove saved Local Token" : "删除已保存的本地 Token"}
        />

        <div class="grid">
          <TextInput
            label={en ? "Local Deployment / Model ID" : "本地模型／部署 ID"}
            value={draft.localModel}
            error={fieldErrors.localModel}
            onValueInput={(v) => updateField("localModel", v)}
          />
          <Select
            label={en ? "Discovered deployments" : "本地部署列表"}
            value={deploymentSelectValue}
            options={[
              {
                value: "",
                label: en ? "Select a deployment…" : "从已刷新的部署中选择…",
              },
              ...(deploymentSelectValue === "__custom__"
                ? [
                    {
                      value: "__custom__",
                      label: en
                        ? `Custom ID (${draft.localModel})`
                        : `自定义 ID（${draft.localModel}）`,
                    },
                  ]
                : []),
              ...deployments.map((d) => ({
                value: d.id,
                label: `${d.id} · ${d.model} · ${localizeDeploymentState(d.state, en)}`,
              })),
            ]}
            onValueChange={(v) => {
              if (v && v !== "__custom__") {
                updateField("localModel", v);
              }
            }}
          />
        </div>
        <p class="hint">{deploymentsNote}</p>

        <div class="grid">
          <Select
            label={en ? "Local compute backend" : "本地计算后端"}
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
          <TextInput
            label={
              en ? "Cold-start wait limit (seconds)" : "冷启动最长等待（秒）"
            }
            type="number"
            min={10}
            max={600}
            step={10}
            value={draft.localStartupTimeoutSec}
            error={fieldErrors.localStartupTimeoutSec}
            hint={
              en
                ? "Does not count against per-request timeout while weights load."
                : "模型加载权重期间独立计时，不占用单次请求超时。"
            }
            onValueInput={(v) => updateField("localStartupTimeoutSec", v)}
          />
        </div>

        <Switch
          checked={draft.localAutoStart}
          onChange={(v) => updateField("localAutoStart", v)}
          label={
            en
              ? "Allow on-demand cold start when local model is stopped"
              : "允许等待本地模型按需冷启动"
          }
          hint={
            en
              ? "Local cache (up to 256 MiB) stays isolated from Cloud cache."
              : "词库与修订命中时不请求管理器；本地推理缓存（上限 256 MiB）与云端缓存严格隔离。"
          }
        />
      </fieldset>

      <fieldset>
        <legend>{en ? "Cloud Translation Service" : "云端翻译服务"}</legend>
        <div class="grid">
          <Select
            label={en ? "Service protocol" : "服务接口类型"}
            value={draft.serviceType}
            options={[
              {
                value: "chat",
                label: en
                  ? "OpenAI-compatible Chat Completions"
                  : "OpenAI 兼容对话接口（Chat Completions）",
              },
              {
                value: "deepl",
                label: en
                  ? "DeepL Translation API"
                  : "DeepL 专用翻译接口（XML 占位符保护）",
              },
            ]}
            onValueChange={(v) =>
              updateField("serviceType", v as "chat" | "deepl")
            }
          />
          <Select
            label={en ? "Quick provider preset" : "常用服务商预设"}
            value=""
            options={[
              {
                value: "",
                label: en
                  ? "Choose a preset to fill URL…"
                  : "选择预设一键填入地址与推荐模型…",
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

        {draft.serviceType === "deepl" ? (
          <>
            <div class="grid">
              <TextInput
                label={en ? "DeepL Endpoint URL" : "DeepL 接口地址"}
                type="url"
                placeholder="https://api.deepl.com/v2/translate"
                value={draft.deeplUrl}
                error={fieldErrors.deeplUrl}
                onValueInput={(v) => updateField("deeplUrl", v)}
              />
              <TextInput
                label="DeepL Auth Key"
                type="password"
                autocomplete="new-password"
                placeholder={
                  config.hasDeeplKey
                    ? en
                      ? "Leave blank to keep saved DeepL Key"
                      : "留空保留已保存的 DeepL Key"
                    : en
                      ? "Enter DeepL API Key"
                      : "输入 DeepL Auth Key"
                }
                value={draft.deeplKey}
                onValueInput={(v) => updateField("deeplKey", v)}
              />
            </div>
            <Checkbox
              checked={draft.clearDeeplKey}
              onChange={(v) => updateField("clearDeeplKey", v)}
              label={en ? "Remove saved DeepL Key" : "删除已保存的 DeepL Key"}
            />
          </>
        ) : (
          <>
            <div class="grid">
              <TextInput
                label={en ? "Cloud API URL" : "API 地址"}
                type="url"
                autocomplete="off"
                value={draft.apiUrl}
                error={fieldErrors.apiUrl}
                onValueInput={(v) => updateField("apiUrl", v)}
              />
              <TextInput
                label="API Key"
                type="password"
                autocomplete="new-password"
                placeholder={
                  config.hasKey
                    ? en
                      ? "Leave blank to keep saved Key"
                      : "留空保留已保存的 Key"
                    : en
                      ? "Enter API Key"
                      : "输入云端 API Key"
                }
                value={draft.apiKey}
                onValueInput={(v) => updateField("apiKey", v)}
              />
            </div>
            <Checkbox
              checked={draft.clearKey}
              onChange={(v) => updateField("clearKey", v)}
              label={en ? "Remove saved API Key" : "删除已保存的云端 API Key"}
            />
            <TextInput
              label={en ? "Cloud Model ID" : "云端模型名称"}
              autocomplete="off"
              value={draft.model}
              error={fieldErrors.model}
              hint={
                isSingleModel
                  ? en
                    ? "Hunyuan-MT uses single-segment official prompts; cache hits are unaffected."
                    : "Hunyuan-MT 按官方协议逐段翻译；需要合并批次时可改选支持 JSON 输出的对话模型。"
                  : en
                    ? "Supports JSON batching in Cloud-only mode."
                    : "支持在「仅云端」模式下开启 JSON 批量合并请求。"
              }
              onValueInput={(v) => updateField("model", v)}
            />
          </>
        )}
      </fieldset>

      <Disclosure
        summary={en ? "Advanced Request & Rate Settings" : "高级请求与批量设置"}
      >
        <div class="grid">
          <TextInput
            label={en ? "Request interval (seconds)" : "请求最小间隔（秒）"}
            type="number"
            min={0}
            max={120}
            step={0.5}
            value={draft.intervalSec}
            error={fieldErrors.intervalSec}
            onValueInput={(v) => updateField("intervalSec", v)}
          />
          <TextInput
            label={en ? "Per-request timeout (seconds)" : "单次超时（秒）"}
            type="number"
            min={10}
            max={180}
            step={5}
            value={draft.timeoutSec}
            error={fieldErrors.timeoutSec}
            onValueInput={(v) => updateField("timeoutSec", v)}
          />
          <TextInput
            label={en ? "Max concurrency (1–4)" : "最大并发请求数（1–4）"}
            type="number"
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
          label={
            en
              ? "Batch translation (up to 16 segments after first paint)"
              : "批量翻译（首屏最多 4 段，后续每批最多 16 段）"
          }
          hint={batchHint}
        />
      </Disclosure>

      <Disclosure
        summary={
          en
            ? "Usage Statistics & Daily Cloud Cap"
            : "用量统计、费用估算与每日云端上限"
        }
      >
        <div class="grid">
          <TextInput
            label={
              en
                ? "Daily cloud request limit (0 = unlimited)"
                : "每日云端请求次数上限（0 为不限）"
            }
            type="number"
            min={0}
            step={10}
            value={draft.dailyRequestLimit}
            onValueInput={(v) => updateField("dailyRequestLimit", v)}
          />
          <TextInput
            label={
              en
                ? "Daily cloud token limit (0 = unlimited)"
                : "每日云端 Token 上限（0 为不限）"
            }
            type="number"
            min={0}
            step={1000}
            value={draft.dailyTokenLimit}
            onValueInput={(v) => updateField("dailyTokenLimit", v)}
          />
          <TextInput
            label={
              en
                ? "Input price / 1M tokens"
                : "输入单价（每百万 Token，用于估算）"
            }
            type="number"
            min={0}
            step={0.01}
            value={draft.inputPricePerMillion}
            onValueInput={(v) => updateField("inputPricePerMillion", v)}
          />
          <TextInput
            label={
              en
                ? "Output price / 1M tokens"
                : "输出单价（每百万 Token，用于估算）"
            }
            type="number"
            min={0}
            step={0.01}
            value={draft.outputPricePerMillion}
            onValueInput={(v) => updateField("outputPricePerMillion", v)}
          />
        </div>
        {usage ? (
          <div class="card">
            <p class="muted">
              {en
                ? `Cumulative — Cloud: ${usage.totalCloudRequests} req (${usage.totalCloudRetries} retries), Local: ${usage.totalLocalRequests} req, Tokens: ${usage.totalPromptTokens + usage.totalCompletionTokens} (${usage.estimatedCount > 0 ? `incl. ${usage.estimatedCount} char-estimated` : "exact"})${estimatedCost ? ` · Est. cost: ${estimatedCost.toFixed(4)}` : ""}`
                : `累计统计 —— 云端请求 ${usage.totalCloudRequests} 次（含重试 ${usage.totalCloudRetries} 次）· 本地请求 ${usage.totalLocalRequests} 次 · 累计 Token ${(usage.totalPromptTokens + usage.totalCompletionTokens).toLocaleString()}（输入 ${usage.totalPromptTokens.toLocaleString()} / 输出 ${usage.totalCompletionTokens.toLocaleString()}${usage.estimatedCount ? `，其中 ${usage.estimatedCount} 次按字符估算` : ""}）${estimatedCost ? ` · 估算费用 ${estimatedCost.toFixed(4)}` : ""}`}
            </p>
            <p class="hint">
              {en
                ? "Stored locally only; never included in diagnostic exports."
                : "用量仅保存在本机浏览器中，导出诊断时不会附带。达到每日云端上限后云端通道自动暂停，不影响本地模型与离线词库。"}
            </p>
            <div class="actions">
              <Button onClick={loadUsage}>
                {en ? "Refresh usage" : "刷新用量"}
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const ok = await confirmAction({
                    message: en
                      ? "Clear all recorded usage statistics?"
                      : "确定清零本地记录的全部用量统计吗？",
                    danger: true,
                    lang,
                  });
                  if (!ok) return;
                  await runTracedUiOp("usage-clear", (t) =>
                    scopedRpc(t).send("USAGE_CLEAR"),
                  );
                  await loadUsage();
                  toast(
                    en ? "Usage statistics cleared." : "已清零用量统计。",
                    "success",
                  );
                }}
              >
                {en ? "Reset usage stats" : "清零统计"}
              </Button>
            </div>
          </div>
        ) : null}
      </Disclosure>

      <div class="actions">
        <Button
          variant="primary"
          busy={store.isBusy("service:save")}
          onClick={handleSave}
        >
          {en ? "Save service settings" : "保存服务配置"}
        </Button>
        <Button busy={store.isBusy("service:test")} onClick={handleTest}>
          {en ? "Test connection" : "测试连接"}
        </Button>
        {store.isBusy("service:test") ? (
          <Button variant="ghost" onClick={() => testAbortRef.current?.abort()}>
            {en ? "Cancel test" : "取消测试"}
          </Button>
        ) : null}
        <Button
          onClick={async () => {
            if (dirtySections.length > 0) {
              const listText = dirtySections.join(en ? ", " : "、");
              const ok = await confirmAction({
                message: en
                  ? `Reloading saved settings will discard unsaved edits in: ${listText}. Continue?`
                  : `重新读取配置将放弃以下分区中尚未保存的更改：${listText}。确定继续吗？`,
                lang,
              });
              if (!ok) return;
            }
            await onReloadAll();
            setTestBanner(null);
            setFieldErrors({});
            toast(
              en ? "Reloaded saved settings." : "已重新读取已保存的配置。",
              "info",
            );
          }}
        >
          {en ? "Reload saved config" : "重新读取配置"}
        </Button>
      </div>
    </section>
  );
}
