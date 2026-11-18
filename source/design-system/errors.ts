export type UiLang = "zh-CN" | "en";

export function normalizeUiLang(lang?: string | null): UiLang {
  if (!lang) return "zh-CN";
  return lang.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

export interface ErrorEntry {
  zh: string;
  en: string;
  field?: string;
  cancelled?: boolean;
  auth?: boolean;
}

export interface ResolvedError {
  code: string;
  message: string;
  raw?: string;
  field?: string;
  isCancelled: boolean;
  isAuthError: boolean;
  isKnown: boolean;
}

const CANCELLED_ENTRIES: Record<string, ErrorEntry> = {
  CANCELLED: {
    zh: "操作已取消。",
    en: "Operation cancelled.",
    cancelled: true,
  },
  IMPORT_CANCELLED: {
    zh: "已取消词库导入；未完成的暂存记录已停止切换，可在词库列表中按需清理。",
    en: "Dictionary import cancelled. Active snapshots remain intact; any remaining staging rows can be aborted from the pack list.",
    cancelled: true,
  },
  cancelled: {
    zh: "操作已取消。",
    en: "Operation cancelled.",
    cancelled: true,
  },
  user_cancelled: {
    zh: "已取消本次操作。",
    en: "Action cancelled by user.",
    cancelled: true,
  },
  dialog_cancelled: {
    zh: "未选择文件，操作已取消。",
    en: "No file selected; action cancelled.",
    cancelled: true,
  },
  webview2_install_cancelled: {
    zh: "已取消安装 WebView2 运行时。",
    en: "WebView2 runtime installation was cancelled.",
    cancelled: true,
  },
};

export const ERROR_DICTIONARY: Record<string, ErrorEntry> = {
  ...CANCELLED_ENTRIES,

  // --- Qingyi Configuration & Validation ---
  INVALID_CONFIG: {
    zh: "配置格式无效，请检查各项设置后重试。",
    en: "Invalid configuration format. Check your settings and try again.",
  },
  INVALID_ENDPOINT: {
    zh: "服务地址格式不正确，请填写不含账号密码的完整 URL（如 https://api.example.com/v1/chat/completions）。",
    en: "Invalid API endpoint URL. Enter a valid URL without embedded credentials.",
    field: "apiUrl",
  },
  HTTPS_REQUIRED: {
    zh: "除本机回环地址（127.0.0.1 / localhost）外，翻译服务地址必须使用 HTTPS。",
    en: "HTTPS is required for non-loopback API endpoints.",
    field: "apiUrl",
  },
  INVALID_MODEL: {
    zh: "请填写有效的模型名称（1–200 个字符）。",
    en: "Enter a valid model identifier (1–200 characters).",
    field: "model",
  },
  INVALID_LOCAL_ENDPOINT: {
    zh: "本地管理器地址必须是本机回环根地址（如 http://127.0.0.1:19820 或 http://localhost:19820），不带多余路径或参数。",
    en: "Local manager URL must be a loopback origin such as http://127.0.0.1:19820 without extra path or query parameters.",
    field: "localUrl",
  },
  IPV6_LOCALHOST_UNSUPPORTED: {
    zh: "Chromium 扩展主机权限不支持 IPv6 回环地址 [::1]，请改填 http://127.0.0.1:端口 或 http://localhost:端口。",
    en: "Chromium extension host permissions do not support IPv6 loopback [::1]. Use http://127.0.0.1:PORT or http://localhost:PORT instead.",
    field: "localUrl",
  },
  LOCAL_URL_REQUIRED: {
    zh: "请先在“翻译服务”中填写本地管理器地址（如 http://127.0.0.1:19820）。",
    en: "Configure the local manager URL in Service settings first.",
    field: "localUrl",
  },
  LOCAL_AUTH_FAILED: {
    zh: "本地管理器拒绝了访问 Token，请从 mistral-gui 复制最新 Token 并保存。",
    en: "Local manager rejected the access token. Copy the current token from mistral-gui and save.",
    auth: true,
    field: "localToken",
  },
  LOCAL_MANAGER_OFFLINE: {
    zh: "无法连接本地模型管理器 mistral-gui，请确认管理器已启动且地址正确。",
    en: "Cannot reach local mistral-gui manager. Confirm it is running and the URL is valid.",
  },
  invalid_exchange_code: {
    zh: "一次性登录授权码已过期或已使用，请从管理器重新打开管理页或手动输入 Token。",
    en: "The one-time sign-in code has expired or was already used. Re-open from the manager or enter your Token.",
    auth: true,
  },
  asset_signature_invalid: {
    zh: "补充运行时资产签名校验未通过，文件已移除。",
    en: "Supplemental runtime signature verification failed; the downloaded archive was removed.",
  },
  asset_url_invalid: {
    zh: "运行时资产下载地址不在受信任的发布源前缀内。",
    en: "Runtime asset download URL does not match the trusted release repository prefix.",
  },
  desktop_inprocess_only: {
    zh: "桌面内部通道仅允许应用进程内调用。",
    en: "Desktop internal handler is restricted to in-process WebView calls.",
  },
  manager_identity_mismatch: {
    zh: "目标端口响应的服务身份与当前数据目录记录不一致，已拒绝发送 Token。",
    en: "Target port service identity does not match this data directory; refused to send Token.",
  },
  credential_decrypt_failed: {
    zh: "系统凭据解密失败（DPAPI），请重新配置 Token 或 API Key。",
    en: "System credential decryption (DPAPI) failed. Reconfigure your Token or API Key.",
  },
  invalid_routing: {
    zh: "调用策略无效，请选择本地优先、仅本地或仅云端。",
    en: "Invalid routing policy. Select local-first, local-only, or cloud-only.",
  },
  invalid_endpoint: {
    zh: "云端服务地址格式无效，非本机地址必须使用 HTTPS。",
    en: "Invalid cloud API URL. HTTPS is required for non-loopback hosts.",
    field: "cloudApiUrl",
  },
  INVALID_ROUTING: {
    zh: "调用策略无效，请选择本地优先、仅本地或仅云端。",
    en: "Invalid routing policy. Choose local-first, local-only, or cloud-only.",
    field: "routing",
  },
  INVALID_LOCAL_CONFIG: {
    zh: "本地模型配置不完整或超出范围，请检查本地模型 ID 与后端选项。",
    en: "Invalid local model configuration. Check the deployment ID and backend.",
    field: "localModel",
  },
  INVALID_KEY: {
    zh: "API Key 长度超出限制，请核对后重新粘贴。",
    en: "API key exceeds the maximum allowed length.",
    field: "apiKey",
  },
  INVALID_INTERVAL: {
    zh: "请求间隔需填写 0–120 之间的秒数（如 1 或 0.5）。",
    en: "Request interval must be a number between 0 and 120 seconds.",
    field: "interval",
  },
  INVALID_TIMEOUT: {
    zh: "单次超时需填写 10–180 之间的秒数。",
    en: "Request timeout must be between 10 and 180 seconds.",
    field: "timeout",
  },
  INVALID_CONCURRENCY: {
    zh: "并发请求数需为 1–4 之间的整数。",
    en: "Concurrency must be an integer from 1 to 4.",
    field: "concurrency",
  },
  INVALID_DISPLAY: {
    zh: "显示方式设置无效，请重新选择。",
    en: "Invalid display mode setting.",
    field: "mode",
  },
  INVALID_BUDGET: {
    zh: "本地缓存总预算需在 0.0625 GiB（64 MiB）至 64 GiB 之间。",
    en: "Cache budget must be between 0.0625 GiB (64 MiB) and 64 GiB.",
    field: "budget",
  },
  INVALID_REPOSITORY: {
    zh: "仓库格式不正确，请按 owner/repo 格式填写（例如 shusfun/Qingyi）。",
    en: "Invalid repository format. Expected owner/repo (e.g. shusfun/Qingyi).",
    field: "releaseRepo",
  },
  INVALID_SETTINGS_IMPORT: {
    zh: "导入的设置文件格式不合法或缺少必要字段。",
    en: "The selected settings file is malformed or missing required fields.",
  },

  // --- Qingyi Codec, Pack & Database ---
  BLOCK_TOO_LARGE: {
    zh: "数据块体积超出安全上限（单块最大 2 MiB）。",
    en: "Data block exceeds the 2 MiB safety limit.",
  },
  DECOMPRESS_LIMIT: {
    zh: "解压后数据超出安全体积限制，已拒绝处理。",
    en: "Decompressed data exceeded the safety limit.",
  },
  CONTAINER_DECOMPRESS_LIMIT: {
    zh: "词库压缩包解压体积超出上限，请检查词库文件是否正确。",
    en: "Dictionary archive exceeded the maximum decompressed size limit.",
  },
  INVALID_CODEC: {
    zh: "缓存数据块编码格式不受支持。",
    en: "Unsupported cache block compression codec.",
  },
  LINE_TOO_LARGE: {
    zh: "单行记录超过长度上限，解析已中止。",
    en: "A single JSONL record exceeded the maximum line length.",
  },
  EMPTY_PACK: {
    zh: "词库文件为空，未找到有效的 manifest。",
    en: "Dictionary pack file is empty or missing a manifest.",
  },
  PACK_FILE_REQUIRED: {
    zh: "请先选择要导入的本地词库文件（.jsonl 或 .gz）。",
    en: "Select a local dictionary file (.jsonl or .gz) first.",
    field: "packFile",
  },
  PACK_HTTPS_REQUIRED: {
    zh: "远程词库来源必须使用不含账号密码的 HTTPS 地址。",
    en: "Remote dictionary URL must use HTTPS without embedded credentials.",
    field: "packUrl",
  },
  IMPORT_IN_PROGRESS: {
    zh: "当前已有词库导入任务正在运行，请等待完成或先取消。",
    en: "Another dictionary import is already in progress.",
  },
  IMPORT_ALREADY_STAGED: {
    zh: "该词库存在未完成的暂存版本，请先在词库列表中点击“中止暂存”再重新导入。",
    en: "This pack already has a staged import. Abort the staged version in the pack list first.",
  },
  INVALID_PACK: {
    zh: "词库包格式无效（需为 qingyi-pack-v1 且包含合法词库 ID）。",
    en: "Invalid dictionary pack format (expected qingyi-pack-v1).",
  },
  INVALID_VERSION: {
    zh: "词库版本号或类型（full / delta）无效。",
    en: "Invalid dictionary pack version or kind (expected full or delta).",
  },
  INVALID_BASE_VERSION: {
    zh: "增量词库的基础版本号不合法。",
    en: "Invalid baseVersion in delta dictionary manifest.",
  },
  BASE_VERSION_MISMATCH: {
    zh: "增量词库的基础版本与本机当前激活版本不一致，请导入对应版本或完整包。",
    en: "Delta pack baseVersion does not match the currently active version.",
  },
  ROLL_FORWARD_OR_FULL_PACK_REQUIRED: {
    zh: "当前词库处于回滚状态，继续导入增量包前请先切回较新版，或直接导入更新的完整包。",
    en: "Pack is rolled back; switch forward first or import a newer full pack.",
  },
  VERSION_NOT_NEWER: {
    zh: "导入的词库版本不高于本机已有版本，无需重复导入。",
    en: "Pack version is not newer than the installed version.",
  },
  PACK_IDENTITY_CHANGED: {
    zh: "同名词库的语言或适用网站范围与已安装版本不一致，若需更换请先删除旧词库。",
    en: "Pack language or domain differs from the installed pack with the same ID.",
  },
  INVALID_LANGUAGE_DOMAIN: {
    zh: "词库声明的语言标签或网站范围格式无效。",
    en: "Invalid language tag or domain scope in dictionary manifest.",
  },
  INVALID_PACK_SIZE: {
    zh: "词库条目数或字节统计值超出有效范围。",
    en: "Invalid entry count or byte size in dictionary manifest.",
  },
  INVALID_BLOCKS: {
    zh: "词库块清单格式无效。",
    en: "Invalid blocks array in dictionary manifest.",
  },
  INVALID_BLOCK: {
    zh: "词库数据块文件名或 SHA-256 摘要格式不合法。",
    en: "Invalid block filename or SHA-256 digest in manifest.",
  },
  BLOCK_LIMIT: {
    zh: "词库单块超出规格上限（单块最多 5000 条、解压后不超过 1 MiB）。",
    en: "Dictionary block exceeds limits (max 5000 entries or 1 MiB uncompressed).",
  },
  MANIFEST_TOTAL_MISMATCH: {
    zh: "词库 manifest 汇总条数/大小与各分块之和不一致。",
    en: "Manifest total entries or bytes do not match the sum of blocks.",
  },
  NO_STAGED_IMPORT: {
    zh: "未找到对应的词库暂存记录。",
    en: "No matching staged dictionary import found.",
  },
  BLOCK_ORDER_MISMATCH: {
    zh: "词库数据块顺序与 manifest 声明不一致，文件可能损坏。",
    en: "Dictionary block order does not match the manifest.",
  },
  BLOCK_CHECKSUM_MISMATCH: {
    zh: "词库数据块 SHA-256 校验未通过，文件在传输或存储中已损坏。",
    en: "Dictionary block SHA-256 checksum mismatch.",
  },
  BLOCK_SIZE_MISMATCH: {
    zh: "词库数据块解压后大小与声明不符。",
    en: "Decompressed block size does not match the manifest.",
  },
  BLOCK_ENTRY_MISMATCH: {
    zh: "词库数据块条目数量与声明不符。",
    en: "Block entry count does not match the manifest.",
  },
  INVALID_PACK_ENTRY: {
    zh: "词库内存在格式不合法或超长的原文条目。",
    en: "Dictionary contains an invalid or oversized source entry.",
  },
  INVALID_PACK_TRANSLATION: {
    zh: "词库条目译文为空或破坏了原文中的占位符。",
    en: "Dictionary entry translation is empty or failed placeholder validation.",
  },
  DUPLICATE_PACK_SOURCE: {
    zh: "同一批次词库中存在重复的原文键。",
    en: "Duplicate source entry detected in dictionary pack.",
  },
  INCOMPLETE_IMPORT: {
    zh: "词库分块尚未接收完整，无法激活。",
    en: "Dictionary import is incomplete and cannot be activated.",
  },
  STAGING_CHANGED: {
    zh: "词库暂存状态已变更，请刷新后重试。",
    en: "Staging state changed concurrently; refresh and retry.",
  },
  NO_ROLLBACK_VERSION: {
    zh: "没有可回滚的上一版本，或当前存在未处理的暂存导入。",
    en: "No previous snapshot available for rollback (or staging is active).",
  },
  ROLLBACK_VERSION_UNAVAILABLE: {
    zh: "上一版本快照已被回收，无法回滚。",
    en: "Previous snapshot is no longer available for rollback.",
  },
  ABORT_IMPORT_FIRST: {
    zh: "请先中止该词库的暂存导入，再删除词库。",
    en: "Abort the staged import before deleting this dictionary.",
  },
  PACK_DELETION_IN_PROGRESS: {
    zh: "该词库正在分批删除中，暂时无法修改设置。",
    en: "This dictionary is currently being deleted.",
  },
  INVALID_PRIORITY: {
    zh: "词库优先级需为 -1000 到 1000 之间的整数。",
    en: "Dictionary priority must be an integer between -1000 and 1000.",
  },
  REVISION_UNAVAILABLE: {
    zh: "未找到对应的修订历史版本，可能已被清理或原文已变更。",
    en: "Requested revision version was not found.",
  },
  CACHE_BUDGET_EXCEEDED: {
    zh: "本地缓存已达到预算上限。可在“本地缓存”分区调高预算或清理旧缓存。",
    en: "Local cache reached its configured budget. Increase budget or clear model cache.",
  },
  DEVICE_SPACE_LOW: {
    zh: "浏览器可用磁盘空间不足，已暂停写入以保护已有数据。",
    en: "Browser storage space is critically low; writes paused to protect existing data.",
  },
  MISSING_BLOCK: {
    zh: "缓存数据块缺失，将重新获取译文。",
    en: "Referenced cache block is missing.",
  },
  CORRUPT_BLOCK: {
    zh: "缓存数据块校验异常，已有数据将保留隔离。",
    en: "Cache block integrity check failed.",
  },
  LOOKUP_LIMIT: {
    zh: "单次查询段落数超出内部限制。",
    en: "Cache lookup batch exceeded internal limit.",
  },
  INVALID_CACHE_ENTRY: {
    zh: "译文未通过占位符或长度校验，未写入缓存。",
    en: "Translation failed placeholder or length validation.",
  },
  CACHE_WRITES_PAUSED: {
    zh: "缓存自动写回处于暂停状态，请检查空间后点击“提交待写缓存”重试。",
    en: "Cache writeback is paused. Free up space and click Flush Pending Cache.",
  },
  CACHE_WRITE_PAUSED: {
    zh: "缓存自动写回已暂停，译文仍正常显示；可在设置页查看原因并手动提交。",
    en: "Cache writeback is paused; translations still display normally.",
  },
  CACHE_COMMIT_FAILED: {
    zh: "数据库事务提交未完成，待写内容已保留在内存中。",
    en: "Database commit failed; pending entries remain buffered in memory.",
  },
  OFFSCREEN_NOT_READY: {
    zh: "后台存储页面尚未就绪，请稍后重试。",
    en: "Extension offscreen storage worker is not ready yet; retry shortly.",
  },
  STORAGE_UNAVAILABLE: {
    zh: "本地存储服务暂不可用，请确认浏览器未禁用扩展后台能力。",
    en: "Local storage worker is unavailable.",
  },
  DATABASE_WORKER_FAILED_DATA_PRESERVED: {
    zh: "SQLite 存储线程异常退出，已有缓存与词库数据均已安全保留，重新操作即可恢复。",
    en: "SQLite worker exited unexpectedly; existing data is preserved.",
  },
  DATABASE_TIMEOUT_OUTCOME_UNKNOWN: {
    zh: "本地数据库响应超时，请稍后刷新统计确认状态。",
    en: "Database operation timed out; refresh storage stats to verify state.",
  },
  OPFS_UNSUPPORTED: {
    zh: "当前浏览器环境不支持 OPFS 文件系统，无法初始化本地数据库。",
    en: "Origin Private File System (OPFS) is not supported in this browser context.",
  },
  INVALID_DATABASE_OPERATION: {
    zh: "不支持的数据库操作请求。",
    en: "Unsupported database operation.",
  },
  DATABASE_FAILED: {
    zh: "本地数据库执行出错，已有数据保持不变。",
    en: "Local database operation failed; existing data remains intact.",
  },
  TRACE_DATABASE_BLOCKED: {
    zh: "诊断存储正被其他标签页升级占用，请稍后重试。",
    en: "Diagnostic IndexedDB is blocked by another context; retry shortly.",
  },
  MAINTENANCE_FAILED: {
    zh: "后台缓存维护未完成，将在下个周期重试。",
    en: "Background cache maintenance did not complete.",
  },

  // --- Qingyi Network, Provider & Extension Runtime ---
  SINGLE_TEXT_MODEL: {
    zh: "当前模型仅支持逐段翻译。",
    en: "Selected model only supports single-segment requests.",
  },
  EMPTY_RESPONSE: {
    zh: "翻译服务返回了空响应。",
    en: "Translation provider returned an empty response.",
  },
  TRANSLATION_TRUNCATED: {
    zh: "模型输出因长度限制被截断，已尝试拆分处理。",
    en: "Model output was truncated by max_tokens limit.",
  },
  STREAM_INTERRUPTED: {
    zh: "流式响应在结束前中断，已完成段落已保留。",
    en: "Streaming response ended prematurely; completed segments were kept.",
  },
  INVALID_PROVIDER_RESPONSE: {
    zh: "翻译服务返回格式不符合预期，未能提取有效译文。",
    en: "Provider returned an unexpected response payload.",
  },
  PROVIDER_RESPONSE_TOO_LARGE: {
    zh: "翻译服务单次返回内容超出 2 MiB 安全上限。",
    en: "Provider response exceeded the 2 MiB safety limit.",
  },
  KEY_REQUIRED: {
    zh: "请先在“翻译服务”设置中填写并保存云端 API Key。",
    en: "Save your cloud API key in Translation Service settings first.",
    auth: true,
    field: "apiKey",
  },
  DEEPL_KEY_REQUIRED: {
    zh: "请先在“翻译服务”中填写并保存 DeepL API Key。",
    en: "Save your DeepL API key in Translation Service settings first.",
    auth: true,
    field: "deeplKey",
  },
  API_PERMISSION_REQUIRED: {
    zh: "尚未授予该翻译服务域名的访问权限，请在设置页点击“保存并核对”完成授权。",
    en: "Host permission for the API endpoint has not been granted. Save settings to authorize.",
    auth: true,
  },
  TIMEOUT: {
    zh: "服务响应超时，已完成部分已保留；可在设置中检查服务状态或调大超时时间。",
    en: "Request timed out. Completed segments were saved.",
  },
  NETWORK_OR_RESPONSE_ERROR: {
    zh: "网络连接异常或服务无响应，请检查网络与服务地址。",
    en: "Network connection failed or service did not respond.",
  },
  ATTEMPTS_EXHAUSTED: {
    zh: "多次重试后仍未成功，请检查服务连通性或配额。",
    en: "All retry attempts failed. Check service connectivity or quota.",
  },
  INVALID_TRANSLATION: {
    zh: "模型返回的译文丢失或打乱了占位符，已保留原文以确保排版安全。",
    en: "Returned translation altered required placeholders; original text kept.",
  },
  DAILY_QUOTA_REACHED: {
    zh: "今日云端用量已达设定的上限，云端请求已暂停（本地模型不受影响）。",
    en: "Daily cloud usage limit reached; cloud requests are paused (local models continue normally).",
  },
  LOCAL_TOKEN_REQUIRED: {
    zh: "请先填写本地管理器 mistral-gui 的访问 Token。",
    en: "Enter the local mistral-gui access token in settings first.",
    auth: true,
    field: "localToken",
  },
  LOCAL_PERMISSION_REQUIRED: {
    zh: "尚未授权访问本地管理器回环地址，请在设置页保存并允许访问。",
    en: "Browser permission for the local manager address is required. Save settings to authorize.",
    auth: true,
  },
  LOCAL_MODEL_MISMATCH: {
    zh: "管理器中未找到所填的本地模型或部署 ID，请点击“刷新本地部署列表”重新选择。",
    en: "Configured deployment/model ID was not found in mistral-gui. Refresh the deployment list.",
    field: "localModel",
  },
  LOCAL_BACKEND_MISMATCH: {
    zh: "本地管理器当前使用的后端与轻译限定的后端不一致，可改为“跟随管理器”。",
    en: "Manager active backend does not match the backend required in settings.",
    field: "localBackend",
  },
  LOCAL_MODEL_NOT_INSTALLED: {
    zh: "本地管理器尚未下载该模型权重，请先在 mistral-gui 中安装模型。",
    en: "Model weights are not installed in mistral-gui yet.",
  },
  LOCAL_INVALID_CATALOG: {
    zh: "本地管理器返回的部署列表格式异常，请确认 mistral-gui 版本。",
    en: "Local manager returned an unexpected deployment list format.",
  },
  LOCAL_RUNTIME_STOPPED: {
    zh: "本地模型当前未启动，且已关闭“按需启动”。请在 mistral-gui 中启动部署或开启按需启动。",
    en: "Local model is stopped and auto-start is disabled. Start it in mistral-gui or enable auto-start.",
  },
  LOCAL_STARTUP_TIMEOUT: {
    zh: "等待本地模型冷启动超过设定时限。",
    en: "Timed out waiting for the local model to finish loading.",
  },
  LOCAL_RUNTIME_COOLDOWN: {
    zh: "本地模型连续启动失败，当前处于冷却保护期；请前往 mistral-gui 查看原因或改用 CPU。",
    en: "Local model entered crash cooldown after repeated failures. Check mistral-gui or switch to CPU.",
  },
  LOCAL_UNAVAILABLE: {
    zh: "无法连接本地模型管理器 mistral-gui，请确认管理器已启动且地址正确。",
    en: "Cannot reach local mistral-gui manager. Confirm it is running.",
  },
  LOCAL_TRANSLATION_FAILED: {
    zh: "本地模型推理未成功。",
    en: "Local model translation failed.",
  },
  WEB_PAGE_REQUIRED: {
    zh: "当前页面不是普通网页（如浏览器内部页或应用商店），浏览器不允许扩展注入翻译。",
    en: "Extensions cannot run on browser internal pages or the Web Store.",
  },
  FILE_ACCESS_REQUIRED: {
    zh: "翻译本地文件需先在浏览器扩展管理页开启“允许访问文件网址”。",
    en: "Enable 'Allow access to file URLs' on the browser extension details page to translate local files.",
  },
  PAGE_CONTROL_FAILED: {
    zh: "无法在当前页面执行操作；若刚安装或更新扩展，请刷新网页后再试。",
    en: "Could not control this page. Refresh the tab if the extension was recently reloaded.",
  },
  SITE_PERMISSION_REQUIRED: {
    zh: "未授予当前网站自动运行权限，自动翻译未开启。",
    en: "Site host permission was not granted; auto-translate was not enabled.",
  },
  PERMISSION_DENIED: {
    zh: "未完成域名访问授权，请允许浏览器权限提示后再试。",
    en: "Domain access permission was declined.",
  },
  INVALID_TRACE: {
    zh: "内部诊断追踪标识无效。",
    en: "Invalid diagnostic trace context.",
  },
  BATCH_LIMIT: {
    zh: "单批翻译字数或条数超出上限，请缩小段落范围后重试。",
    en: "Translation batch exceeded item or character limits.",
  },
  INVALID_SENDER: {
    zh: "拒绝了来自未知来源的扩展消息。",
    en: "Rejected message from untrusted sender.",
  },
  INVALID_POSITION: {
    zh: "进度条位置坐标超出有效范围。",
    en: "Progress bar coordinates out of range.",
  },
  OPTIONS_PAGE_REQUIRED: {
    zh: "该操作仅允许在轻译设置页中执行。",
    en: "This action is restricted to the Qingyi settings page.",
  },
  CONFIG_VERIFY_FAILED: {
    zh: "设置写入后回读校验不一致，请检查浏览器存储状态后重试。",
    en: "Configuration read-back verification failed after saving.",
  },
  INVALID_PREFERENCES: {
    zh: "界面外观或进度条偏好参数无效。",
    en: "Invalid theme or progress visibility preference.",
  },
  INVALID_OPERATION: {
    zh: "不支持的存储管理操作。",
    en: "Unsupported storage operation.",
  },
  UNKNOWN_OPERATION: {
    zh: "未知的后台操作指令。",
    en: "Unknown background command.",
  },
  FAILED: {
    zh: "操作未能完成，请重试。",
    en: "Operation could not be completed.",
  },
  OPERATION_FAILED: {
    zh: "后台操作执行失败。",
    en: "Background operation failed.",
  },
  UI_OPERATION_FAILED: {
    zh: "界面操作未完成。",
    en: "Interface action failed.",
  },
  SETTINGS_OPEN_FAILED: {
    zh: "无法打开设置页，请从浏览器扩展管理页进入。",
    en: "Could not open settings tab; open it from browser extension management.",
  },
  EXTENSION_DISCONNECTED: {
    zh: "扩展后台刚重新唤醒或已更新，正在恢复连接；若未自动继续请刷新页面。",
    en: "Extension background worker reconnected; refresh the page if translation does not resume.",
  },
  EXTENSION_UNAVAILABLE: {
    zh: "轻译后台暂时未响应，请稍后重试或在扩展管理页重新加载。",
    en: "Extension background service did not respond; retry or reload the extension.",
  },
  MIGRATION_CODE_REQUIRED: {
    zh: "请输入旧版轻译生成的 6 位数字迁移验证码。",
    en: "Enter the 6-digit numeric migration code from the legacy extension.",
    field: "migrationCode",
  },
  MIGRATION_REFUSED: {
    zh: "旧版扩展拒绝了迁移请求，请确认旧版扩展已开启一次性迁移且验证码未过期。",
    en: "Legacy extension refused migration. Verify the 6-digit code has not expired.",
    field: "migrationCode",
  },
  MIGRATION_KEY_VERIFY_FAILED: {
    zh: "迁移后 API Key 核对未通过，旧版数据仍保留，请重试。",
    en: "Migrated API key verification failed; legacy data remains untouched.",
  },
  INVALID_RELEASE_RESPONSE: {
    zh: "更新源返回的 JSON 结构不合法。",
    en: "Update repository returned malformed JSON.",
  },
  INVALID_RELEASE_VERSION: {
    zh: "更新源最新 Release 的版本号标签格式无效（需形如 v3.1.0）。",
    en: "Latest release tag is not a valid semantic version.",
  },
  INVALID_RELEASE_ASSETS: {
    zh: "更新源 Release 缺少有效的附件列表。",
    en: "Release metadata is missing an assets list.",
  },
  INVALID_RELEASE_ASSET_URL: {
    zh: "更新包下载地址未通过 GitHub 官方仓库路径校验。",
    en: "Release asset download URL failed repository origin validation.",
  },
  INVALID_RELEASE_ASSET_SIZE: {
    zh: "更新包文件大小异常（为空或超过 128 MiB）。",
    en: "Release asset file size is invalid.",
  },
  DUPLICATE_RELEASE_ASSET: {
    zh: "更新源 Release 存在重名安装包，已拒绝加载。",
    en: "Duplicate release asset names detected.",
  },
  RELEASE_RATE_LIMITED: {
    zh: "GitHub API 访问频率已达上限，请稍后再检查更新。",
    en: "GitHub API rate limit reached. Try checking for updates later.",
  },
  EMPTY_RELEASE_RESPONSE: {
    zh: "更新源返回了空内容，请稍后重试。",
    en: "Update server returned an empty response.",
  },
  RELEASE_NETWORK_OR_RESPONSE_FAILED: {
    zh: "无法连接更新源，请检查网络或自定义仓库地址。",
    en: "Could not reach the update repository. Check your network connection.",
  },
  SYNC_DISABLED: {
    zh: "词库与修订同步尚未开启。",
    en: "Dictionary and revision sync is currently disabled.",
  },
  SYNC_FAILED: {
    zh: "同步到本地管理器未完成，请确认 mistral-gui 正在运行且 Token 有效。",
    en: "Failed to sync with mistral-gui. Confirm the manager is running and token is valid.",
  },

  // --- mistral-gui Backend & Frontend Codes ---
  networkError: {
    zh: "无法连接本地管理器，可能已退出或端口未响应。",
    en: "Cannot reach mistral-gui manager. It may have exited or stopped listening.",
  },
  invalid_response: {
    zh: "管理器返回了无法解析的响应格式。",
    en: "Manager returned an unreadable response payload.",
  },
  empty_response: {
    zh: "模型返回了空内容，请检查部署状态或提示词。",
    en: "Model returned an empty response.",
  },
  chooseModel: {
    zh: "请先选择一个模型后再保存或部署。",
    en: "Select a model before saving or deploying.",
    field: "model",
  },
  loopback_required: {
    zh: "出于安全限制，管理器仅允许绑定本机回环地址（127.0.0.1 或 ::1）。",
    en: "For security, mistral-gui only binds to loopback addresses (127.0.0.1 or ::1).",
  },
  host_rejected: {
    zh: "请求 Host 头非本机回环地址，已被拒绝。",
    en: "Request Host header is not a loopback address and was rejected.",
  },
  origin_rejected: {
    zh: "跨域来源不在允许列表中（仅允许本机管理页与授权的轻译扩展 ID）。",
    en: "Request Origin is not authorized (only local console and allowed Qingyi extension IDs are permitted).",
  },
  invalid_token: {
    zh: "访问 Token 无效或已更换，请重新输入当前管理器的 Token。",
    en: "Invalid or expired access token. Enter the current manager token.",
    auth: true,
  },
  exchange_code_invalid: {
    zh: "一次性登录凭证已失效或已被使用，请重新从托盘打开或输入 Token 登录。",
    en: "One-time login code expired or was already used. Sign in with your token.",
    auth: true,
  },
  invalid_json: {
    zh: "提交的请求参数格式不正确。",
    en: "Malformed JSON request payload.",
  },
  invalid_theme: {
    zh: "不支持的外观主题选项（仅支持跟随系统、浅色、深色）。",
    en: "Unsupported theme option (expected system, light, or dark).",
    field: "theme",
  },
  invalid_language: {
    zh: "不支持的界面语言（仅支持简体中文与 English）。",
    en: "Unsupported interface language (expected zh-CN or en-US).",
    field: "language",
  },
  invalid_backend: {
    zh: "不支持的推理后端（可选 Auto、CPU、CUDA、Metal）。",
    en: "Invalid inference backend (expected auto, cpu, cuda, or metal).",
    field: "backend",
  },
  invalid_idle_minutes: {
    zh: "空闲自动停止时间需为 0–1440 之间的整数分钟（0 表示不自动停止）。",
    en: "Idle stop timeout must be between 0 and 1440 minutes (0 disables auto-stop).",
    field: "idle",
  },
  invalid_mirror: {
    zh: "下载镜像前缀格式无效：每行必须是不含查询参数与账号信息的 HTTPS 地址（如 https://mirror.example.com/）。",
    en: "Invalid mirror prefix: each line must be an HTTPS base URL without credentials or query parameters.",
    field: "mirrors",
  },
  invalid_kind: {
    zh: "不支持的资产安装类型。",
    en: "Unsupported asset installation kind.",
  },
  invalid_ui_events: {
    zh: "前端诊断上报数据超出格式限制。",
    en: "UI diagnostic event payload invalid.",
  },
  endpoint_unknown: {
    zh: "请求的接口路径不存在。",
    en: "Requested API endpoint does not exist.",
  },
  settings_write_failed: {
    zh: "保存配置文件失败，请检查数据目录写入权限与剩余磁盘空间。",
    en: "Failed to write settings to disk. Check directory permissions and disk space.",
  },
  deployment_unknown: {
    zh: "找不到指定的部署实例，可能已被删除。",
    en: "Specified deployment instance does not exist.",
  },
  deployment_busy: {
    zh: "该部署正在执行准备或切换任务，请等待当前任务完成或取消后再操作。",
    en: "This deployment has an active preparation task in progress.",
  },
  deployment_id_reserved: {
    zh: "该部署 ID 已被默认实例或系统保留名称占用，请换用其他名称（如 translation-local）。",
    en: "This deployment ID is reserved. Choose a different ID such as translation-local.",
    field: "deploymentId",
  },
  invalid_deployment_id: {
    zh: "部署 ID 需以字母或数字开头，仅含字母、数字、点、下划线或连字符（最长 96 字符，且不能为 default 或 new）。",
    en: "Deployment ID must start with an alphanumeric character and contain only letters, digits, '.', '_', or '-' (max 96 chars, not 'default' or 'new').",
    field: "deploymentId",
  },
  invalid_tuning: {
    zh: "高级运行参数超出有效范围（上下文 0–1048576、并发序列 0–4096、显存占用比例 0–1）。",
    en: "Advanced tuning values out of range (context 0–1048576, sequences 0–4096, GPU utilization 0–1).",
    field: "tuning",
  },
  invalid_kv_cache: {
    zh: "KV Cache 格式不正确，请按正整数加单位填写，例如 512MiB、4GiB 或 8192tokens（不留空格）。",
    en: "Invalid KV cache format. Use a positive integer followed by MiB, GiB, or tokens (e.g. 512MiB, 4GiB, 8192tokens).",
    field: "kvCache",
  },
  invalid_isq: {
    zh: "加载时量化（ISQ）选项无效，可选留空、Q4K、Q6K 或 Q8_0。",
    en: "Invalid ISQ quantization option (expected empty, Q4K, Q6K, or Q8_0).",
    field: "isq",
  },
  invalid_repository: {
    zh: "模型仓库名称不合法，请填写形如 owner/repo 的 Hugging Face 仓库标识。",
    en: "Invalid Hugging Face repository identifier (expected owner/repo).",
    field: "repository",
  },
  stop_before_switch: {
    zh: "该部署当前正在运行中，请先点击“停止”后再修改配置、切换模型或删除。",
    en: "Stop the running deployment before modifying configuration, switching models, or deleting it.",
  },
  previous_model_missing: {
    zh: "没有可切回的上一版已安装模型。",
    en: "No previous model version is available to roll back to.",
  },
  previous_engine_missing: {
    zh: "没有可切回的上一版推理引擎运行时。",
    en: "No previous runtime engine is available to roll back to.",
  },
  task_in_progress: {
    zh: "当前已有后台任务正在运行，请等待完成或取消后再试。",
    en: "Another task is currently running. Wait for it to finish or cancel it first.",
  },
  installation_in_progress: {
    zh: "已有下载或更新任务正在进行，请等待完成后再发起新安装。",
    en: "An installation or update task is already running.",
  },
  manager_stopped: {
    zh: "本地管理器已停止运行。",
    en: "Local manager has stopped.",
  },
  manager_restarted: {
    zh: "管理器上次退出或重启时中断了此后台任务，可按需点击重试。",
    en: "This background task was interrupted when the manager restarted.",
  },
  manager_updating: {
    zh: "管理器正在安装更新并重启，请稍候数秒后自动重连。",
    en: "Manager is applying an update and restarting; reconnect in a few seconds.",
  },
  active_requests_running: {
    zh: "当前仍有正在处理的推理请求，请等待请求完成或停止部署后再执行更新。",
    en: "Inference requests are currently in flight. Wait for them to finish or stop deployments before updating.",
  },
  data_dir_locked: {
    zh: "该数据目录正被另一个 mistral-gui 实例占用，不能同时启动两个使用同一目录的管理器。",
    en: "The data directory is locked by another running mistral-gui instance.",
  },
  operation_failed: {
    zh: "操作执行失败，可展开查看详细技术原因。",
    en: "Operation failed. Expand technical details for the underlying cause.",
  },
  install_engine_and_model_first: {
    zh: "尚未安装所需的推理运行时或模型权重，请点击“部署并启动”自动准备，或前往“模型”页下载。",
    en: "Required runtime engine or model weights are not installed yet. Use Deploy & Start or download them on the Models page.",
  },
  engine_missing: {
    zh: "未找到匹配的 mistral.rs 运行时文件，请重新下载对应后端的运行时。",
    en: "Runtime binary is missing on disk. Download or repair the runtime for this backend.",
  },
  model_not_installed: {
    zh: "所选模型尚未安装或文件缺失，请先下载模型。",
    en: "Selected model is not installed on disk. Download it first.",
  },
  engine_start_failed: {
    zh: "推理引擎进程启动失败，请检查系统运行库（如 VC++ 运行库）或防病毒拦截。",
    en: "Failed to launch the inference engine process. Check VC++ redistributables or security software.",
  },
  process_supervision_failed: {
    zh: "无法建立引擎进程守护托管，已中止启动以防残留孤儿进程。",
    en: "Failed to attach OS process supervision to the engine.",
  },
  engine_exited: {
    zh: "推理引擎在加载或运行中异常退出，请在部署详情查看引擎最后输出日志，或尝试“改用 CPU”。",
    en: "Inference engine exited unexpectedly. Check the engine log output in deployment details or switch to CPU.",
  },
  model_load_timeout: {
    zh: "模型加载超过 5 分钟仍未就绪，已自动终止；建议检查显存余量或改用量化更小/CPU 配置。",
    en: "Model loading timed out after 5 minutes. Check available VRAM/RAM or try a smaller quantization / CPU.",
  },
  engine_not_ready: {
    zh: "引擎进程未进入就绪状态。",
    en: "Inference engine did not reach ready state.",
  },
  runtime_stopped: {
    zh: "目标部署尚未启动，且未开启按需自动启动。",
    en: "Target deployment is stopped and auto-start on request is disabled.",
  },
  runtime_loading: {
    zh: "本地模型正在启动加载中，请稍候…",
    en: "Local model is currently loading; please wait…",
  },
  runtime_cooldown: {
    zh: "该部署因连续启动失败处于冷却保护期，可查看失败原因后点击“立即重试”或“改用 CPU”。",
    en: "Deployment is in crash cooldown after repeated failures. Review the error and click Retry Now or Switch to CPU.",
  },
  engine_connection_failed: {
    zh: "无法转发请求到内部推理引擎，引擎可能刚退出。",
    en: "Failed to connect to internal inference engine process.",
  },
  nvidia_driver_unavailable: {
    zh: "未检测到可用的 NVIDIA 显卡驱动（nvidia-smi），当前环境不可使用 CUDA。",
    en: "NVIDIA driver (nvidia-smi) not detected; CUDA is unavailable on this machine.",
  },
  loading_memory_budget_exceeded: {
    zh: "加载峰值内存/显存预计超过当前可用余量，加载期间可能较慢或失败。",
    en: "Estimated peak loading memory exceeds currently available memory.",
  },
  memory_available_unknown: {
    zh: "未能读取当前系统的可用内存余量，推荐参数仅供参考。",
    en: "Available system memory could not be determined; recommendations are advisory.",
  },
  memory_budget_exceeded: {
    zh: "模型预计占用超过当前可用内存/显存，已自动下调上下文长度或改推其他后端。",
    en: "Estimated model footprint exceeds available memory; context or backend was adjusted.",
  },
  invalid_asset: {
    zh: "资产元数据不完整或不受支持。",
    en: "Asset metadata is incomplete or unsupported.",
  },
  engine_binary_missing: {
    zh: "解压后的运行时包内未找到 mistralrs 可执行文件。",
    en: "Runtime archive did not contain the mistralrs executable.",
  },
  backend_invalid: {
    zh: "当前操作系统或架构不支持所选硬件加速后端。",
    en: "Selected acceleration backend is not supported on this OS/architecture.",
  },
  model_in_use: {
    zh: "该模型正被部署实例引用或正在运行中，请先停止并调整相关部署后再删除。",
    en: "This model is currently referenced by a deployment or running engine. Update or remove the deployment first.",
  },
  model_unknown: {
    zh: "在目录中未找到该模型，请刷新模型仓库列表或核对仓库名。",
    en: "Model was not found in the catalog. Refresh the repository list or check the repo name.",
  },
  model_files_missing: {
    zh: "模型目录中缺少必需的权重或配置文件。",
    en: "Required model weight or configuration files are missing.",
  },
  invalid_model_path: {
    zh: "模型文件路径包含非法字符、保留设备名或越界路径。",
    en: "Model file path contains unsafe segments or reserved OS names.",
  },
  model_index_invalid: {
    zh: "safetensors 分片索引文件（model.safetensors.index.json）损坏或格式无效。",
    en: "Invalid or corrupt model.safetensors.index.json file.",
  },
  model_shard_missing: {
    zh: "safetensors 模型缺少索引声明的分片文件，请确认分片完整后重试。",
    en: "One or more safetensors weight shards referenced by the index are missing.",
  },
  model_existing_corrupt: {
    zh: "本地已安装的模型文件校验不通过（可能损坏），可点击重新下载覆盖修复。",
    en: "Existing installed model files failed integrity verification. Re-download to repair.",
  },
  model_file_invalid: {
    zh: "模型文件完整性校验失败，可重新下载修复该模型。",
    en: "Model file failed SHA-256 verification. Re-download to repair.",
  },
  model_format_unsupported: {
    zh: "不支持该模型文件格式（目前仅支持 .gguf 单文件/分片与 safetensors 目录）。",
    en: "Unsupported model format (only .gguf files and safetensors directories are supported).",
  },
  model_symlink_unsupported: {
    zh: "出于安全考虑，导入本地模型不支持符号链接文件或目录，请选择真实文件路径。",
    en: "Symbolic links are not permitted when importing local models.",
  },
  model_support_files_missing: {
    zh: "safetensors 目录缺少 config.json 或 tokenizer 配置文件。",
    en: "safetensors directory is missing config.json or tokenizer files.",
  },
  model_weights_missing: {
    zh: "目录中未找到有效的模型权重文件。",
    en: "No valid model weight files found in the selected directory.",
  },
  platform_unsupported: {
    zh: "当前操作系统或处理器架构暂不在预编译运行时支持范围内（仅支持 Windows x64 与 macOS）。",
    en: "Current OS/CPU architecture is not supported by prebuilt runtimes (Windows x64 and macOS only).",
  },
  platform_ocr_unsupported: {
    zh: "桌面端屏幕框选截图翻译目前仅支持 Windows 平台。",
    en: "Desktop screen-capture OCR translation is currently supported on Windows only.",
  },
  official_digest_missing: {
    zh: "上游官方 Release 未提供 SHA-256 校验摘要，出于安全策略已拒绝下载。",
    en: "Upstream release is missing a SHA-256 digest and was refused for safety.",
  },
  asset_missing: {
    zh: "未找到适配当前平台与后端的运行时发行资产。",
    en: "No matching runtime release asset found for this platform and backend.",
  },
  supplement_repository_required: {
    zh: "官方源缺少当前平台资产，且当前构建未配置补充运行时仓库。",
    en: "Official release lacks an asset for this platform and no supplemental repository is configured.",
  },
  invalid_model_revision: {
    zh: "模型仓库返回的修订版本标识不合法。",
    en: "Repository returned an invalid commit revision identifier.",
  },
  model_architecture_unverified: {
    zh: "该仓库的模型架构尚未在当前 mistral.rs 引擎兼容列表中确认。",
    en: "Model architecture in config.json is not on the verified mistral.rs compatibility list.",
  },
  model_catalog_too_large: {
    zh: "目标模型仓库文件数量过大，超出目录解析上限。",
    en: "Target Hugging Face repository file tree exceeded the catalog size limit.",
  },
  invalid_catalog_pagination: {
    zh: "模型目录分页链接校验未通过。",
    en: "Model catalog pagination link failed validation.",
  },
  model_file_digest_missing: {
    zh: "模型文件缺少可验证的 SHA-256 / Git LFS 摘要。",
    en: "Model file metadata is missing a verifiable SHA-256 digest.",
  },
  digest_required: {
    zh: "下载任务缺少预期校验摘要，已拒绝执行。",
    en: "Download refused because no expected cryptographic digest was provided.",
  },
  digest_mismatch: {
    zh: "下载文件 SHA-256 校验不一致，已丢弃损坏文件并记录异常源，请重试下载。",
    en: "Downloaded file failed SHA-256 verification and was discarded. Retry download.",
  },
  download_source_missing: {
    zh: "没有可用的下载源地址。",
    en: "No valid download URL available.",
  },
  download_slow_source: {
    zh: "下载源传输速率过低且切换备用镜像后仍超时，请检查网络或配置 HTTPS 镜像。",
    en: "Download source stalled below minimum speed threshold. Check network or configure a mirror.",
  },
  download_idle_timeout: {
    zh: "下载连接超过 60 秒无数据传输，已中断（已有进度已保留，重试可断点续传）。",
    en: "Download stalled for 60s. Progress is saved in .part and can be resumed on retry.",
  },
  download_connection_failed: {
    zh: "无法连接下载服务器（或镜像源），请检查网络后重试（支持断点续传）。",
    en: "Could not connect to the download server or mirror. Check network and retry.",
  },
  download_http_error: {
    zh: "下载服务器返回异常状态码，请检查镜像配置或稍后重试。",
    en: "Download server returned an HTTP error status.",
  },
  download_size_limit: {
    zh: "下载内容超出允许的文件大小上限。",
    en: "Download exceeded the maximum allowed file size.",
  },
  download_interrupted: {
    zh: "下载连接中途断开，已完成部分已保存，点击重试即可续传。",
    en: "Download stream interrupted; partial file saved for resume on retry.",
  },
  download_range_invalid: {
    zh: "服务器返回的断点续传区间无效，将重新校验或重下。",
    en: "Server returned an invalid HTTP Range response.",
  },
  insufficient_disk_space: {
    zh: "目标磁盘剩余可用空间不足（含解压与安全余量），请清理磁盘后再下载或导入。",
    en: "Insufficient free disk space on the target drive (including extraction margin).",
  },
  unsafe_archive_path: {
    zh: "压缩包内含越界或绝对路径条目，已被安全拦截。",
    en: "Archive contains unsafe relative or absolute paths and was rejected.",
  },
  archive_size_limit: {
    zh: "压缩包解压总大小超出安全上限。",
    en: "Archive unpacked size exceeded the safety limit.",
  },
  archive_link_rejected: {
    zh: "压缩包内包含符号链接或特殊文件，已被安全拒绝。",
    en: "Archive contains symbolic links or irregular files and was rejected.",
  },
  manager_connection_failed: {
    zh: "无法与本机运行中的管理器实例通信。",
    en: "Failed to communicate with the running mistral-gui instance.",
  },
  desktop_action_required: {
    zh: "此操作需要在桌面窗口内完成。",
    en: "This action must be initiated from the desktop application window.",
  },
  update_repository_unconfigured: {
    zh: "当前为本地开发构建，未配置在线自更新仓库（正式发行版才启用自更新）。",
    en: "Self-update repository is not configured in this development build.",
  },
  update_key_unconfigured: {
    zh: "当前构建未内置更新签名公钥，无法执行签名自更新。",
    en: "Update verification public key is not configured in this build.",
  },
  already_current: {
    zh: "当前安装的已是最新版本。",
    en: "You are already running the latest version.",
  },
  update_asset_missing: {
    zh: "最新 Release 中未找到适配当前系统的更新包资产。",
    en: "Latest release does not contain an update package for this platform.",
  },
  macos_app_required: {
    zh: "macOS 自更新要求先将应用拖入可写的 Applications 目录运行。",
    en: "Move mistral-gui.app to a writable Applications folder before self-updating on macOS.",
  },
  invalid_confirmation: {
    zh: "确认状态无效，请重新操作。",
    en: "Confirmation payload invalid; please retry.",
  },
  diagnostics_failed: {
    zh: "导出诊断文件失败，请检查目标目录写入权限。",
    en: "Failed to export diagnostics file. Check destination permissions.",
  },
  desktop_command_unknown: {
    zh: "桌面端不支持该原生操作指令。",
    en: "Unsupported desktop bridge command.",
  },
  update_in_progress: {
    zh: "管理器正在执行更新流程，请勿重复操作。",
    en: "An application update is already in progress.",
  },
  invalid_update_transaction: {
    zh: "更新守护事务参数无效。",
    en: "Invalid update transaction metadata.",
  },
  update_target_mismatch: {
    zh: "更新目标路径校验不匹配，已中止替换。",
    en: "Update target executable path mismatch.",
  },
  old_manager_exit_timeout: {
    zh: "旧版本管理器退出超时，更新未覆盖原程序。",
    en: "Timed out waiting for the previous manager process to exit.",
  },
  update_process_identity_mismatch: {
    zh: "重启后的进程身份与预期新版本不一致，守护进程已执行安全回滚。",
    en: "Updated process identity mismatch; rolled back to previous version.",
  },
  update_health_check_failed: {
    zh: "新版本启动后 60 秒内健康自检未通过，已自动回退到更新前版本。",
    en: "New version failed health check within 60s and was automatically rolled back.",
  },
  update_digest_missing: {
    zh: "更新清单 SHA256SUMS 缺少对应安装包摘要，已拒绝更新。",
    en: "Update SHA256SUMS is missing the digest for this asset.",
  },
  update_signature_invalid: {
    zh: "更新包 Ed25519 数字签名校验失败，已拒绝安装。",
    en: "Ed25519 signature verification failed for the update manifest.",
  },
  manifest_invalid: {
    zh: "更新清单格式损坏或不完整。",
    en: "Update release manifest is malformed.",
  },
  manifest_expired: {
    zh: "更新清单已过期，请刷新检查最新发行版。",
    en: "Signed update manifest has expired.",
  },
  manifest_replay_rejected: {
    zh: "检测到低于历史已见版本的旧更新清单，已拦截重放。",
    en: "Rejected update manifest older than previously seen release.",
  },
  https_required: {
    zh: "更新与远程资产地址必须使用 HTTPS。",
    en: "HTTPS is required for update and remote asset URLs.",
  },
  version_invalid: {
    zh: "版本号格式不合法。",
    en: "Invalid semantic version string.",
  },
  update_asset_invalid: {
    zh: "更新资产地址或文件名未通过安全检查。",
    en: "Update asset URL or filename failed validation.",
  },
  metadata_too_large: {
    zh: "远端元数据响应超出大小限制。",
    en: "Remote metadata response exceeded size limit.",
  },
  invalid_update_trace: {
    zh: "更新追踪上下文格式无效。",
    en: "Invalid update traceparent header.",
  },
  invalid_health_url: {
    zh: "健康检查地址必须是本机回环地址。",
    en: "Health check URL must be a loopback address.",
  },
  invalid_update_target: {
    zh: "更新目标文件路径无效。",
    en: "Invalid update target executable path.",
  },
  invalid_update_executable: {
    zh: "新版本可执行文件缺失或无法运行。",
    en: "Staged update executable is missing or invalid.",
  },
  update_link_rejected: {
    zh: "更新目标路径包含符号链接，已拒绝替换。",
    en: "Symbolic links are not allowed on update target paths.",
  },
  webview2_installer_too_large: {
    zh: "WebView2 引导安装器文件大小异常，已停止安装。",
    en: "WebView2 bootstrapper exceeded expected size limit.",
  },
  webview2_signature_invalid: {
    zh: "WebView2 安装器未通过 Microsoft 数字签名验证。",
    en: "WebView2 installer failed Microsoft Authenticode verification.",
  },
  webview2_install_failed: {
    zh: "WebView2 运行时安装失败，请尝试从微软官网手动安装。",
    en: "WebView2 runtime installation failed.",
  },
  webview2_install_not_detected: {
    zh: "安装完成后仍未检测到 WebView2 运行时。",
    en: "WebView2 runtime was still not detected after installation.",
  },
  cloud_key_required: {
    zh: "请先在设置中填写并保存云端服务的 API Key。",
    en: "Configure and save the cloud service API key in Settings first.",
    auth: true,
    field: "cloudKey",
  },
  cloud_not_configured: {
    zh: "尚未完成云端服务配置（API 地址、模型与 Key），请前往“设置”填写。",
    en: "Cloud translation API is not configured yet. Configure URL, model, and API key in Settings.",
  },
  ocr_not_installed: {
    zh: "尚未下载本地 OCR 识别运行时，请确认下载后再使用图片/截图翻译。",
    en: "Local OCR runtime is not installed yet. Download it first to translate images or screenshots.",
  },
  ocr_busy: {
    zh: "OCR 运行时正在安装或启动中，请稍候。",
    en: "OCR runtime is currently installing or starting.",
  },
  ocr_failed: {
    zh: "图片文字识别（OCR）失败，请重试或在设置中检查 OCR 运行时状态。",
    en: "Optical character recognition (OCR) failed. Retry or check OCR runtime status in Settings.",
  },
  ocr_empty_text: {
    zh: "未在所选区域或图片中识别到可翻译的文字。",
    en: "No readable text was detected in the selected image.",
  },
  cloud_image_confirmation_required: {
    zh: "当前调用策略可能将图片识别出的文字发送至云端服务，请先确认隐私提示后再继续。",
    en: "Current routing may send OCR-extracted text to the cloud provider. Please confirm privacy notice first.",
  },
  sync_limit_exceeded: {
    zh: "单次同步的词库或修订数量超出安全上限。",
    en: "Dictionary sync payload exceeded item count limits.",
  },
  SYNC_LIMIT_EXCEEDED: {
    zh: "词库或修订超过单次同步上限，本次未同步；原有副本保持不变。",
    en: "Dictionary or revisions exceed the sync limit. Existing copies were retained.",
  },
  translation_input_limit: {
    zh: "一次最多翻译 128 段，请分批提交；本次没有发送翻译请求。",
    en: "Translate up to 128 paragraphs at a time. Split the input into smaller batches.",
  },
  credential_store_failed: {
    zh: "无法保存到系统钥匙串，请检查钥匙串访问权限。",
    en: "Could not save credentials to the system keychain. Check keychain access.",
  },
  autostart_failed: {
    zh: "开机自启项写入失败，请检查系统权限设置。",
    en: "Failed to update login auto-start registration.",
  },
};

// Map legacy literal Chinese/English strings thrown in older code paths to canonical codes
const LITERAL_ALIASES: Record<string, string> = {
  "请完成域名授权。": "PERMISSION_DENIED",
  请选择词库文件: "PACK_FILE_REQUIRED",
  已有导入在运行: "IMPORT_IN_PROGRESS",
  "词库来源必须是无账号密码的 HTTPS 地址": "PACK_HTTPS_REQUIRED",
  "仅支持 HTTPS": "HTTPS_REQUIRED",
  "后台未响应，请重新启用轻译后重试。": "EXTENSION_UNAVAILABLE",
  "updater: Init has not been called": "update_repository_unconfigured",
};

function matchDynamicHttpCode(
  code: string,
  lang: UiLang,
): { message: string; auth?: boolean } | null {
  const en = lang === "en";
  let m =
    /^(LOCAL_HTTP_|HTTP_|PACK_HTTP_|RELEASE_HTTP_|DEEPL_HTTP_)(\d{3})$/.exec(
      code,
    );
  if (m) {
    const prefix = m[1];
    const status = Number(m[2]);
    const isLocal = prefix === "LOCAL_HTTP_";
    const isPack = prefix === "PACK_HTTP_";
    const isRelease = prefix === "RELEASE_HTTP_";
    const isDeepl = prefix === "DEEPL_HTTP_";
    const targetZh = isLocal
      ? "本地管理器"
      : isPack
        ? "词库服务器"
        : isRelease
          ? "更新源 GitHub"
          : isDeepl
            ? "DeepL 服务"
            : "翻译服务";
    const targetEn = isLocal
      ? "Local manager"
      : isPack
        ? "Dictionary server"
        : isRelease
          ? "GitHub release server"
          : isDeepl
            ? "DeepL API"
            : "Translation provider";

    if (status === 401 || status === 403) {
      return {
        auth: true,
        message: isLocal
          ? en
            ? "Local manager rejected the token (HTTP " +
              status +
              "). Copy the current token from mistral-gui and retry."
            : `本地管理器拒绝了此 Token（HTTP ${status}）。请从 mistral-gui 复制当前 Token 后重试。`
          : en
            ? `${targetEn} rejected authentication or access (HTTP ${status}). Verify your API key and permissions.`
            : `${targetZh}拒绝了鉴权或访问（HTTP ${status}），请检查 Key 或访问权限。`,
      };
    }
    if (status === 404) {
      return {
        message: en
          ? `${targetEn} returned 404 Not Found. Check the configured URL or model/repository name.`
          : `${targetZh}返回 404 未找到，请检查填写的地址、模型或仓库名称。`,
      };
    }
    if (status === 413) {
      return {
        message: en
          ? `${targetEn} rejected the request payload as too large (HTTP 413).`
          : `${targetZh}提示单次请求内容过大（HTTP 413）。`,
      };
    }
    if (status === 422 || status === 400) {
      return {
        message: en
          ? `${targetEn} rejected the request parameters (HTTP ${status}). Check model name and endpoint compatibility.`
          : `${targetZh}拒绝了请求参数（HTTP ${status}），请核对模型名称与接口兼容性。`,
      };
    }
    if (status === 429) {
      return {
        message: en
          ? `${targetEn} rate-limited or quota-limited the request (HTTP 429). Please retry shortly.`
          : `${targetZh}触发限流或配额限制（HTTP 429），请稍后重试。`,
      };
    }
    if (status >= 500) {
      return {
        message: en
          ? `${targetEn} encountered a server error (HTTP ${status}). Retry shortly.`
          : `${targetZh}暂时不可用或内部异常（HTTP ${status}），请稍后重试。`,
      };
    }
    return {
      message: en
        ? `${targetEn} returned unexpected HTTP status ${status}.`
        : `${targetZh}返回异常状态（HTTP ${status}）。`,
    };
  }

  m =
    /^(metadata_http_|update_signature_http_|webview2_download_http_)(\d{3})$/.exec(
      code,
    );
  if (m) {
    const kind = m[1];
    const status = Number(m[2]);
    if (kind === "metadata_http_") {
      return {
        message:
          status === 404
            ? en
              ? "Repository or release was not found on upstream server (HTTP 404)."
              : "未在上游平台找到对应的模型仓库或发行版（HTTP 404）。"
            : status === 429
              ? en
                ? "Upstream catalog API rate limit reached (HTTP 429). Try again later."
                : "上游模型/资产目录请求频率受限（HTTP 429），请稍后再试。"
              : en
                ? `Upstream metadata server returned HTTP ${status}.`
                : `读取上游目录元数据失败（HTTP ${status}）。`,
      };
    }
    if (kind === "update_signature_http_") {
      return {
        message: en
          ? `Failed to download update signature file (HTTP ${status}).`
          : `获取更新签名文件失败（HTTP ${status}）。`,
      };
    }
    return {
      message: en
        ? `Failed to download WebView2 installer from Microsoft (HTTP ${status}).`
        : `从 Microsoft 下载 WebView2 安装器失败（HTTP ${status}）。`,
    };
  }
  return null;
}

function extractRawString(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err.trim();
  if (err instanceof Error) {
    if (err.name === "AbortError") return "CANCELLED";
    return (err.message || err.name || "").trim();
  }
  if (typeof err === "object") {
    const obj = err as Record<string, any>;
    if (typeof obj.error === "string") return obj.error.trim();
    if (typeof obj.error?.code === "string") return obj.error.code.trim();
    if (typeof obj.code === "string") return obj.code.trim();
    if (typeof obj.message === "string") return obj.message.trim();
  }
  return String(err).trim();
}

export function resolveError(
  err: unknown,
  langInput?: string | null,
): ResolvedError {
  const lang = normalizeUiLang(langInput);
  const en = lang === "en";
  const raw = extractRawString(err);

  if (!raw) {
    return {
      code: "UNKNOWN_ERROR",
      message: en
        ? "Operation did not complete. Please retry."
        : "操作未能完成，请重试。",
      isCancelled: false,
      isAuthError: false,
      isKnown: false,
    };
  }

  // Detect browser fetch / network disconnect TypeErrors
  if (
    /Failed to fetch|NetworkError when attempting to fetch|Load failed|fetch failed/i.test(
      raw,
    )
  ) {
    const entry = ERROR_DICTIONARY.networkError;
    return {
      code: "networkError",
      message: en ? entry.en : entry.zh,
      raw,
      isCancelled: false,
      isAuthError: false,
      isKnown: true,
    };
  }

  // Normalize Wails RuntimeError wrappers or colon-prefixed codes like "model_file_invalid: ..."
  const cleaned = raw
    .replace(/^RuntimeError:\s*/i, "")
    .replace(/^Bound method returned an error:\s*/i, "")
    .trim();

  const alias = LITERAL_ALIASES[cleaned];
  const candidate =
    alias ||
    (/^[A-Za-z0-9_]+(?=:)/.exec(cleaned)?.[0] ??
      (/^[A-Za-z0-9_]+$/.test(cleaned) ? cleaned : ""));

  if (candidate && ERROR_DICTIONARY[candidate]) {
    const entry = ERROR_DICTIONARY[candidate];
    return {
      code: candidate,
      message: en ? entry.en : entry.zh,
      raw: raw !== candidate ? raw : undefined,
      field: entry.field,
      isCancelled: !!entry.cancelled,
      isAuthError: !!entry.auth,
      isKnown: true,
    };
  }

  if (candidate) {
    const dyn = matchDynamicHttpCode(candidate, lang);
    if (dyn) {
      return {
        code: candidate,
        message: dyn.message,
        raw: raw !== candidate ? raw : undefined,
        isCancelled: false,
        isAuthError: !!dyn.auth,
        isKnown: true,
      };
    }
  }

  // Also check if a known code appears inside a longer error string
  for (const key of Object.keys(ERROR_DICTIONARY)) {
    if (key.length >= 6 && cleaned.includes(key)) {
      const entry = ERROR_DICTIONARY[key];
      return {
        code: key,
        message: en ? entry.en : entry.zh,
        raw,
        field: entry.field,
        isCancelled: !!entry.cancelled,
        isAuthError: !!entry.auth,
        isKnown: true,
      };
    }
  }

  return {
    code: candidate || "UNKNOWN_ERROR",
    message: en
      ? "Operation could not be completed. Expand technical details for the raw cause."
      : "操作未能完成，可展开下方详情查看具体原因。",
    raw,
    isCancelled: false,
    isAuthError: false,
    isKnown: false,
  };
}

export function formatUnknown(
  value: number | string | null | undefined,
  langInput?: string | null,
  formatter?: (v: number) => string,
): string {
  const unknownLabel = normalizeUiLang(langInput) === "en" ? "Unknown" : "未知";
  if (value === null || value === undefined || value === "") {
    return unknownLabel;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return unknownLabel;
    return formatter ? formatter(value) : value.toLocaleString();
  }
  if (value === "unknown") return unknownLabel;
  return value;
}

export function formatBytes(
  bytes: number | null | undefined,
  langInput?: string | null,
): string {
  return formatUnknown(bytes, langInput, (n) => {
    if (n < 0) return normalizeUiLang(langInput) === "en" ? "Unknown" : "未知";
    const mib = 1024 * 1024;
    const gib = 1024 * mib;
    if (n >= gib) return (n / gib).toFixed(2) + " GiB";
    if (n >= mib) return (n / mib).toFixed(2) + " MiB";
    if (n >= 1024) return (n / 1024).toFixed(1) + " KiB";
    return Math.round(n).toLocaleString() + " B";
  });
}

export function formatDurationMs(
  ms: number | null | undefined,
  langInput?: string | null,
): string {
  return formatUnknown(ms, langInput, (n) => {
    if (n >= 1000) return (n / 1000).toFixed(2) + " s";
    if (n >= 10) return Math.round(n) + " ms";
    return Number(n.toFixed(1)) + " ms";
  });
}
