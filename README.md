# 轻译 3.0

轻量 Chromium MV3 网页翻译扩展。入口为网页右键菜单和设置页，网页仅显示可关闭的小进度条。暖米白、炭黑、陶土橙配色。

[下载当前版本](https://github.com/shusfun/Qingyi/releases/latest) · [本地模型接入指南](docs/local-model.md) · [独立管理器 mistral-gui](https://github.com/shusfun/mistral-gui)

本地设置支持刷新管理器部署列表并选择实例，也可手动填写部署 ID。mistral-gui 使用 Wails 窗口，关闭缩到托盘，明确退出才停止全部模型；各部署独立启停。缓存同时隔离模型 revision 和部署参数。英文接入说明见 [Local model guide](docs/local-model.en.md)。

仓库维护 `source` 源码，`extension` 是本机唯一加载目录，`releases` 只保留当前版本 ZIP 与摘要。Git 不跟踪构建目录和浏览器个人数据。推送与 `source/package.json` 版本一致的 `vX.Y.Z` tag 后，Actions 检查并发布当前版本。新安装默认更新仓库为 `shusfun/Qingyi`；旧设置如留空，可在设置页手动填写。

## 安装和构建

要求 Node.js 22 以上。在 `source` 中执行 `npm ci`、`npm run check`、`npm test`、`npm run build`，直接更新同级唯一的 `extension` 目录；`npm run release` 将当前版本 ZIP 和 SHA-256 写入同级 `releases`。在 ego、Chrome 或 Edge 扩展管理页启用开发者模式，始终加载 `extension` 整个目录。后续更新保持目录和 manifest key 不变，重新加载即可。

固定的公开 manifest key 位于 `manifest-key.txt`，请随发布保留，不能每次构建重新生成。插件没有工具栏 action 或大悬浮面板。API 地址支持 Chat Completions；Key 留空保留已有值。首次保存需在浏览器完成域名授权。设置页可测试连接，测试调用可能产生模型费用。

Hunyuan-MT 使用官方单段翻译提示模板，长段优先按句子拆成约 900 字符的请求，保留占位符；整段校验通过后进入缓存并回填。逐段调度在诊断中标记 `model-single-text`，长段拆分标记 `long-segment-split`。请求使用流式响应，并兼容返回普通 JSON 的接口；默认单次超时 60 秒，可在设置中调整。超时最多尝试两次，单段失败继续处理其他段落。其他模型可使用 JSON 批量翻译。该模型的缓存策略独立，避免复用旧提示生成的结果。

本地模型通过独立的 mistral-gui 管理器连接。设置页填写回环地址（默认 `http://127.0.0.1:19820`）、Token、模型 ID 和后端；Token 留空保留原值。默认本地优先，也可选择仅本地或仅云端。本地不可用或某段失败时，本地优先按段回退云端；仅本地不会向云端发送内容。词库和用户修订命中时不联系管理器、不启动模型。本地与云端分别排队限速，按段调度的译文可独立回填。

网页右键可切换中文、双语、原文、暂停、显示本页进度、网站自动翻译和设置。× 只隐藏本页进度；永久隐藏在设置页操作。点击进度条中的“轻译”打开设置，拖动则保存本设备位置。完成后显示失败段数，再次翻译可复用已完成缓存并重试失败段落。链接元素与代码节点保留；段落结构使用占位符，返回后核对原文快照及占位符顺序，失败时保留原文。设置页按需查询诊断，每页最多 200 条，完整保留记录通过导出查看。

## 缓存与数据

SQLite WASM 在扩展离屏页面的单 Worker 中使用 OPFS SAHPool。需要 WASM、offscreen、OPFS 支持；初始化失败会报错并保留数据，不自动重建数据库。缓存文件在浏览器管理的扩展私有存储中，**不在安装目录**。卸载扩展或清理浏览器扩展存储可能删除数据；保留词库原包。

默认总预算 4 GiB，保留索引、日志和暂存余量。热缓存 8 MiB，待写 8 MiB，解压块缓存 16 MiB，另有 SQLite 页缓存和运行时开销。约 256 KiB 原文块使用原生 gzip；收益不足时存原块。只解压命中块。模型缓存最多延迟 60 秒批量提交，崩溃可能丢失尚未提交的模型结果；可手动提交。用户修订及时事务提交。命中不写入访问时间、持久 LRU 或计数。

本地模型结果使用独立索引，按模型修订隔离，配额为 256 MiB（含压缩块和索引的估算）。达到配额时按写入顺序淘汰本地结果，保留词库、用户修订和云端结果；物理文件空间可能由 SQLite 保留以供复用。清理模型缓存同时清理本地与云端模型结果。

写回遇到容量或数据库错误时保留有界缓冲并暂停自动重试；译文仍可显示。设置页显示原因，腾出空间后用“提交待写缓存”手动重试。解压缓存的内存预算按字符串和对象开销估算，浏览器进程的实际内存还包含运行时及 WASM。

优先级：用户修订 → 启用且语言/领域兼容的词库 → 隔离模型缓存。模型缓存区分网站、接口、模型、策略。词库 sourceLang `auto` 对应网页自动识别请求，`*` 兼容任意原语言；domain `*` 兼容所有网站，否则应为网站 origin（如 `https://example.com`）。修订使用精确原文、原语言、目标语言及 origin；段落占位符须保留。

不会自动执行 VACUUM 或整库压实。分批维护可取消，自动维护应用提交量每小时最多 8 MiB；应用提交字节是应用层估算，**不代表 SSD 物理擦写量**。模型缓存、词库和修订历史分别删除。

## 词库包格式

首版是定义明确的 JSONL 容器，可再 gzip。首行 `{"manifest":{...}}`，后续每行 `{"file":"block-0.jsonl.gz","data":"BASE64_GZIP"}`，顺序与 manifest.blocks 一致。不会将整个包读入内存。每块 gzip 的 SHA-256 在解压前校验，解压后校验字节数、条数和记录格式。每块原始最多 1 MiB、5000 条，传输最多 2 MiB。每条包含 `source` 和 `translation`；增量删除为 `{"source":"...","deleted":true}`。

manifest 字段：`format:"qingyi-pack-v1"`、`id`、递增 `version`、`kind:"full"|"delta"`、`baseVersion:null|number`、`sourceLang`、`targetLang`、`domain`、`entries`、`uncompressedBytes`、`blocks`。每个块包含 `file`、`sha256`、`bytes`、`uncompressedBytes`、`entries`。完整包的基础版为 null；增量必须匹配当前活动版本。导入先暂存校验，再事务切换。中断、损坏、空间不足时旧版继续可用；重新导入前可中止暂存。

生成包：`node scripts/pack.mjs input.jsonl output.jsonl my-pack 1 auto zh-CN '*'`。增量最后追加基础版本号。来源可为本地文件或 HTTPS；检查和更新均手动发起。新来源的摘要只能验证完整性，信任仍由来源决定。当前与上一快照可切换；用户修订保留最近 20 次。过期行与孤立块逐批回收，因此旧数据物理回收可能延后。

回滚到上一版后，继续导入增量前需再次切换回较新版，或导入版本号更大的完整包；首版不支持从回滚点分叉增量历史。增量中的相同译文沿用已有有效区间。中止暂存、删除模型缓存和词库索引均分批执行，关闭设置页后可继续操作。

导入失败或取消时仅自动清理一批暂存记录，避免错误触发长时间删除。剩余暂存显示在词库列表，使用“中止暂存”继续处理；活动词库保持可用。

## 诊断与隐私

每次网页操作产生 traceId、operationId、sessionId；每批 batchId，每次 HTTP 尝试独立 spanId。内部扫描、缓存、队列、数据库、HTTP 和回填相关联。请求携带 W3C traceparent 和 X-Request-ID，供应商返回请求 ID 时记录关联；供应商内部不可观测，没有返回 ID 时显示不可关联。

诊断不记录 Key、原文、译文、完整请求体。明细上限 5 MiB / 14 天；内存缓冲最多每分钟提交一次，与缓存提交分别计量。设置页按 traceId / batchId 查询、导出脱敏 JSON 或清除。崩溃可能丢失尚在内存的诊断。导出文件请自行保管。

## 更新和旧版迁移

`npm run release` 生成版本 ZIP 和 SHA-256。设置 GitHub `owner/repo`，手动检查最新 Release 并下载。安装包名须为 `qingyi-版本号-chromium.zip`，摘要文件名为安装包名加 `.sha256`；检查器只提供该仓库中与 Release 版本匹配的资源。没有匹配包或摘要时会明确提示。核对摘要后替换目录、重新加载；未打包扩展不能自动安装更新。本项目构建不发布远程仓库。构建产物仅含程序和文档，不包含浏览器中的配置、Key、缓存或诊断。

旧版设置页的一次性迁移入口只允许指定新旧 ID 之间通信，验证码短时有效。新设置页输入验证码后，Key 通过扩展消息进入新扩展本地存储，不写明文文件。旧缓存保留旧网站/模型/策略分区，无法反推的网站分区继续隔离，不提升为通用词库。完成前保留旧安装和数据；迁移后需按浏览器要求重新授权 API 和网站。

旧版没有迁移入口时，在源码目录执行 `node scripts/migration-bridge.mjs "旧扩展目录"`，然后重新加载旧版，再从旧版设置生成验证码。本版只接受固定旧 ID `edhbbapfabbclogflaljpghhfmkopohn`；其他旧安装需要自行核对并修改源码中的允许列表。

## 参考与依赖

本实现独立编写。交互与工程思路参考 KISS Translator（https://github.com/fishjar/kiss-translator）及 Read Frog（https://github.com/mengxi-ream/read-frog），参考范围为右键入口、翻译分段和设置组织，未复制其实现代码。SQLite WASM 使用 `@sqlite.org/sqlite-wasm`（https://github.com/sqlite/sqlite-wasm），遵循其发布许可；SQLite 内核为公有领域。TypeScript 与 esbuild 为构建依赖。所有执行脚本与 WASM 本地打包，不下载执行远程代码。

本版不含视频字幕、OCR 或远程数据库。千万条容量、速度、空间峰值取决于实际语料和设备，不能由条数推算固定容量；浏览器内“冷”测试释放应用/SQLite 缓存，不能等同于操作系统磁盘缓存完全冷启动。
