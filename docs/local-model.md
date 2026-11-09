# Qingyi 与本地模型

管理器采用 Wails 桌面窗口，关闭缩到托盘，明确退出才结束全部模型。可以创建多个独立部署；插件设置页点击“刷新本地部署列表”后选择实例，也可手动填写 ID。缓存按模型修订和部署配置隔离。已安装相同版本旧包时下载覆盖一次；插件仍覆盖原目录并重新加载，不额外安装副本。英文说明见 [Local model guide](local-model.en.md)。

Qingyi 是浏览器插件，[mistral-gui](https://github.com/shusfun/mistral-gui) 是独立桌面管理器，二者分别安装和更新。插件不会内嵌推理引擎或模型权重。

## 安装插件

从 [Qingyi 最新 Release](https://github.com/shusfun/Qingyi/releases/latest) 下载 `qingyi-版本-chromium.zip` 及对应 `.sha256`。核对摘要后解压到固定目录，在 Chrome、Edge 或 ego 的扩展管理页启用开发者模式，加载解压后的整个目录。之后更新同一目录并重新加载，避免创建多个插件副本。固定 manifest key 用于维持扩展 ID；它是公开标识，不是 API Key。

本地开发在 `source` 中运行 `npm ci`、`npm run check`、`npm test`、`npm run release`，构建直接覆盖同级 `extension`。源码和安装产物属于不同用途，不需要分别加载。

## 连接管理器

1. 安装 [mistral-gui](https://github.com/shusfun/mistral-gui/releases/latest)，按其向导下载运行时与 HY-MT 模型。
2. 从管理器 API 页面复制本地地址、Token、模型 ID。
3. 在插件设置填写 `http://127.0.0.1:19820`、Token、模型 ID 和后端，允许浏览器访问该地址。
4. 选择路由并测试连接。允许自动启动时，管理器可在第一个实际推理请求时加载模型。

| 路由 | 行为 |
| --- | --- |
| 本地优先 | 本地不可用或某段失败时，对该段使用配置的云端服务 |
| 仅本地 | 本地失败直接报告，不向云端发送内容 |
| 仅云端 | 使用配置的云端 API |

本地优先仍需自行配置云端 API 才能成功回退。Token 留空保存时保留已有值；不要把 Token 或云端 Key 放进共享截图和代码仓库。

## 词库与缓存

查找顺序为用户修订、兼容词库、隔离的模型缓存、实际推理。词库和修订命中不调用管理器、不启动模型。停止模型后仍可复用匹配修订的本地缓存。管理器不可访问时，插件无法确认模型修订，本地优先可能转向云端。

本地模型缓存默认 256 MiB，和云端缓存隔离，并区分模型修订。自动淘汰本地结果不会删除词库、用户修订或云端结果。卸载插件或清理其浏览器存储可能删除这些数据；请保留词库原包。

## 更新与故障

设置页中的更新仓库使用 `shusfun/Qingyi`。未打包扩展只提供下载与摘要校验，不能绕过浏览器自动安装更新。管理器使用自己的签名更新通道；运行时和权重另行管理。

连接失败先检查管理器是否运行、本地地址权限、Token、所选模型和后端。GPU 加载失败在管理器中查看实际原因或明确降级到 CPU。诊断可按 traceId 关联插件和管理器的启动、请求及回填阶段；导出内容经过脱敏，不包含原文、译文和 Key。

## English

Install the [Qingyi extension release](https://github.com/shusfun/Qingyi/releases/latest) into one stable directory, and install [mistral-gui](https://github.com/shusfun/mistral-gui/releases/latest) separately. Copy its localhost address, token, model ID and backend into extension settings, then grant browser access to localhost.

Choose local-first with per-paragraph cloud fallback, local-only without cloud fallback, or cloud-only. Configure a cloud API if fallback is needed. Dictionary and correction hits never start the model. Local results have a separate 256 MiB cache keyed by model revision. Extension updates are downloaded manually into the same installation directory; manager updates use a separate signed channel.
