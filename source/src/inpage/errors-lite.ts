export type PageUiLang = "zh-CN" | "en";

export function normalizePageLang(lang?: string | null): PageUiLang {
  return (lang || "").toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

const PAGE_ERRORS: Record<string, [zh: string, en: string]> = {
  CANCELLED: ["操作已取消。", "Operation cancelled."],
  KEY_REQUIRED: [
    "请先在设置页填写并保存云端 API Key。",
    "Save your cloud API key in Settings first.",
  ],
  DEEPL_KEY_REQUIRED: [
    "请先在设置页填写并保存 DeepL API Key。",
    "Save your DeepL API key in Settings first.",
  ],
  API_PERMISSION_REQUIRED: [
    "尚未授予翻译服务域名权限，请前往设置页点击保存完成授权。",
    "API host permission required. Open Settings and save to authorize.",
  ],
  LOCAL_TOKEN_REQUIRED: [
    "请先在设置页填写本地管理器 mistral-gui 的 Token。",
    "Enter your mistral-gui token in Settings first.",
  ],
  LOCAL_PERMISSION_REQUIRED: [
    "尚未授予本地管理器回环地址权限，请在设置页保存完成授权。",
    "Local manager host permission required. Save in Settings to authorize.",
  ],
  LOCAL_MODEL_MISMATCH: [
    "本地管理器中未找到所选部署或模型，请在设置页刷新本地列表。",
    "Configured local deployment/model was not found in mistral-gui.",
  ],
  LOCAL_BACKEND_MISMATCH: [
    "本地管理器后端与设置不一致，请在设置页核对后端选项。",
    "Local manager backend does not match configured backend.",
  ],
  LOCAL_MODEL_NOT_INSTALLED: [
    "本地管理器尚未安装该模型权重。",
    "Selected local model weights are not installed yet.",
  ],
  LOCAL_RUNTIME_STOPPED: [
    "本地模型当前未启动且已关闭按需启动，请在 mistral-gui 中启动。",
    "Local model is stopped and auto-start is disabled.",
  ],
  LOCAL_RUNTIME_LOADING: [
    "本地模型正在加载中，请稍候…",
    "Local model is loading; please wait…",
  ],
  LOCAL_STARTUP_TIMEOUT: [
    "等待本地模型冷启动超时。",
    "Timed out waiting for local model startup.",
  ],
  LOCAL_RUNTIME_COOLDOWN: [
    "本地模型连续启动失败处于冷却期，请在 mistral-gui 查看原因或改用 CPU。",
    "Local model is in crash cooldown. Check mistral-gui or switch to CPU.",
  ],
  LOCAL_UNAVAILABLE: [
    "无法连接本地模型管理器 mistral-gui，请确认已启动。",
    "Cannot connect to local mistral-gui manager.",
  ],
  DAILY_QUOTA_REACHED: [
    "今日云端用量已达上限，云端请求已暂停（本地模型不受影响）。",
    "Daily cloud quota reached; cloud requests paused.",
  ],
  TIMEOUT: ["翻译请求响应超时。", "Translation request timed out."],
  NETWORK_OR_RESPONSE_ERROR: [
    "网络连接异常或服务未响应。",
    "Network error or no response from translation service.",
  ],
  ATTEMPTS_EXHAUSTED: [
    "多次重试后仍未成功，请检查服务状态或配额。",
    "All retry attempts failed. Check service status or quota.",
  ],
  INVALID_TRANSLATION: [
    "译文占位符校验未通过，已保留原文。",
    "Translation altered placeholders; original text preserved.",
  ],
  TRANSLATION_TRUNCATED: [
    "模型输出被长度上限截断。",
    "Model output was truncated.",
  ],
  EMPTY_RESPONSE: ["翻译服务返回空内容。", "Provider returned empty response."],
  INVALID_PROVIDER_RESPONSE: [
    "翻译服务返回格式异常。",
    "Unexpected provider response format.",
  ],
  EXTENSION_DISCONNECTED: [
    "扩展后台正在重连；若未继续请刷新页面。",
    "Extension worker reconnecting; refresh page if needed.",
  ],
  EXTENSION_UNAVAILABLE: [
    "扩展后台暂未响应，请稍后重试。",
    "Extension worker unavailable; please retry.",
  ],
  WEB_PAGE_REQUIRED: [
    "当前页面不允许注入翻译脚本。",
    "Extensions cannot run on this browser page.",
  ],
  FILE_ACCESS_REQUIRED: [
    "请在扩展管理页开启“允许访问文件网址”。",
    "Enable 'Allow access to file URLs' in extension settings.",
  ],
  SITE_PERMISSION_REQUIRED: [
    "未授予此网站自动运行权限。",
    "Site host permission was declined.",
  ],
  OPFS_UNSUPPORTED: [
    "当前浏览器上下文不支持本地 OPFS 存储。",
    "OPFS storage is unsupported in this browser context.",
  ],
};

export function resolvePageError(
  err: unknown,
  langInput?: string | null,
): { code: string; message: string; isCancelled: boolean } {
  const lang = normalizePageLang(langInput);
  const en = lang === "en";
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "FAILED";
  const code = raw.trim();
  if (code === "CANCELLED" || /abort|cancel/i.test(code)) {
    return {
      code: "CANCELLED",
      message: en ? "Operation cancelled." : "操作已取消。",
      isCancelled: true,
    };
  }
  const hit = PAGE_ERRORS[code];
  if (hit) {
    return { code, message: en ? hit[1] : hit[0], isCancelled: false };
  }
  const m = /^(LOCAL_HTTP_|HTTP_|DEEPL_HTTP_)(\d{3})$/.exec(code);
  if (m) {
    const isLocal = m[1] === "LOCAL_HTTP_";
    const status = Number(m[2]);
    if (status === 401 || status === 403) {
      return {
        code,
        message: isLocal
          ? en
            ? `Local manager rejected Token (HTTP ${status}).`
            : `本地管理器拒绝了 Token（HTTP ${status}），请在设置页更新。`
          : en
            ? `API key rejected (HTTP ${status}).`
            : `翻译服务拒绝了鉴权（HTTP ${status}），请检查 API Key。`,
        isCancelled: false,
      };
    }
    if (status === 429) {
      return {
        code,
        message: en
          ? "Rate-limited or quota exceeded (HTTP 429)."
          : "触发限流或配额限制（HTTP 429），请稍后重试。",
        isCancelled: false,
      };
    }
    return {
      code,
      message: en
        ? `Service returned HTTP ${status}.`
        : `${isLocal ? "本地管理器" : "翻译服务"}返回异常状态（HTTP ${status}）。`,
      isCancelled: false,
    };
  }
  return {
    code,
    message: en
      ? "Translation failed; check Settings."
      : "翻译未完成，可在设置页查看原因。",
    isCancelled: false,
  };
}
