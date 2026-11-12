import { send, scoped, record, runOperation } from "./ui/request";
import {
  button,
  details,
  confirmAction,
  applyTheme,
  createDrafts,
  empty,
  records,
} from "./ui/components.js";
import type { SettingsView, CacheStatus, TracePage } from "./ui/models";
import { newTrace, childTrace, traceparent } from "./trace";
import {
  DEFAULTS,
  MiB,
  type Trace,
  type CacheInput,
  type PackManifest,
} from "./types";
import { lines } from "./codec";
import { renderRelease } from "./releases-view";
import { singleTextModel } from "./model-profile";
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
let config: SettingsView;
const drafts = createDrafts();
let importing: AbortController | undefined,
  maintenance = false;
let maintenanceTrace: Trace | undefined, importTrace: Trace | undefined;
const db = (operation: string, args: unknown[] = [], trace = newTrace()) =>
  send("DATABASE", { operation, args, trace: childTrace(trace) });
function showStatus(id: string, value: unknown) {
  $(id).setAttribute("role", "status");
  $(id).dataset.tone = "neutral";
  $(id).nextElementSibling?.matches(".error-detail") &&
    $(id).nextElementSibling?.remove();
  if (typeof value === "string") $(id).textContent = value;
  else $(id).replaceChildren(details("详情", value));
}
function bind(
  id: string,
  action: (trace: Trace) => Promise<unknown>,
  status = "status",
) {
  const button = $<HTMLButtonElement>(id);
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      await runOperation(id, action);
    } catch (e) {
      const connectionFailure =
        status === "connection-test-status" ? localConnectionError(e) : null;
      showStatus(
        status,
        status.startsWith("release-")
          ? releaseError(e)
          : (connectionFailure?.message ??
              "操作未完成，请检查设置或权限后重试."),
      );
      $(status).setAttribute("role", "alert");
      $(status).dataset.tone = "error";
      if (connectionFailure?.managerUrl) {
        const link = document.createElement("a");
        link.href = connectionFailure.managerUrl;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = document.documentElement.lang.startsWith("en")
          ? "Open deployment connection details"
          : "打开管理器的部署连接信息";
        $(status).append(" ", link);
      }
      const detail = details(
        "查看错误原因",
        e instanceof Error ? e.message : "操作失败",
      );
      detail.className = "error-detail";
      $(status).after(detail);
    } finally {
      button.removeAttribute("aria-busy");
      button.disabled = button.dataset.unavailable === "true";
      $("draft-state").hidden = !drafts.any();
    }
  });
}
function localConnectionError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (/LOCAL_HTTP_(401|403)|invalid_token/i.test(code)) {
    const english = document.documentElement.lang.startsWith("en");
    let managerUrl: string | undefined;
    try {
      managerUrl = new URL("/manage#instances", input("local-url").value).href;
    } catch {
      // Keep the recovery instructions even when the configured URL is malformed.
    }
    return {
      message: english
        ? "The manager rejected this token. Copy the current token from the deployment connection details and retry."
        : "管理器拒绝了此 Token。请从部署连接信息复制当前 Token 后重试。",
      managerUrl,
    };
  }
  return null;
}
function show(c: SettingsView) {
  const savedDrafts = drafts.snapshot();
  config = c;
  applyTheme(c["ui.theme"] || "system");
  input("theme").value = c["ui.theme"] || "system";
  showStatus(
    "local-key-state",
    c.hasLocalToken ? "本地 Token 已配置" : "本地 Token 未配置",
  );
  input("api-url").value = c.apiUrl;
  input("routing").value = c.routing;
  input("local-url").value = c.localUrl;
  input("local-token").value = "";
  input("clear-local-token").checked = false;
  input("local-model").value = c.localModel;
  input("local-backend").value = c.localBackend;
  input("local-auto-start").checked = c.localAutoStart;
  input("api-key").value = "";
  input("clear-key").checked = false;
  input("model").value = c.model;
  modelHint();
  input("interval").value = String(c.intervalMs / 1000);
  input("timeout").value = String(c.timeoutMs / 1000);
  input("concurrency").value = String(c.concurrency);
  input("mode").value = c.mode;
  input("batch").checked = c.batch;
  input("budget").value = String(c.budgetBytes / (1024 * MiB));
  input("release-repo").value = c.releaseRepo;
  $("release-source").textContent = "当前更新源：" + c.releaseRepo;
  input("progress-visible").checked = c["ui.progressVisible"] !== false;
  showStatus(
    "key-state",
    c.hasKey ? "✓ Key 已保存在本浏览器" : "尚未填写 Key（离线词库仍可使用）",
  );
  $("sites").replaceChildren();
  for (const site of Object.keys(c.sites || {})) {
    const row = document.createElement("div");
    row.className = "actions";
    const text = document.createElement("span");
    text.textContent = site;
    const control = button("关闭自动翻译");

    control.onclick = () => {
      void runOperation("remove-site", async (t) => {
        control.disabled = true;
        const { send } = scoped(t);
        await send("REMOVE_SITE", { origin: site });
        show(await send("PRIVATE"));
      })
        .catch((e) => showStatus("reading-status", e.message))
        .finally(() => {
          control.disabled = false;
        });
    };
    row.append(text, control);
    $("sites").append(row);
  }
  if (!$("sites").children.length)
    empty($("sites"), "还没有自动翻译的网站，可在网页右键菜单中开启。");
  drafts.restore(savedDrafts);
}
function modelHint() {
  $("model-hint").textContent = singleTextModel(input("model").value)
    ? "Hunyuan-MT 按段翻译。需要批量时，可选择支持 JSON 输出的对话模型；缓存命中不受影响。"
    : "批量模式需要模型支持按编号返回 JSON 译文；不支持时会缩小批次重试。";
}
input("model").addEventListener("input", modelHint);
bind(
  "refresh-local-models",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    await grant(input("local-url").value, t);
    const entries = await send("LOCAL_MODELS", {
      config: draft(),
      trace: t,
    });
    const select = $<HTMLSelectElement>("local-model-select"),
      list = $("local-model-list");
    select.replaceChildren(new Option("选择部署或手动填写 ID", ""));
    list.replaceChildren();
    for (const item of entries) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.id} · ${item.model} · ${item.state}`;
      select.append(option);
      const hint = document.createElement("option");
      hint.value = item.id;
      list.append(hint);
    }
    if (entries.some((d: any) => d.id === input("local-model").value))
      select.value = input("local-model").value;
    showStatus(
      "local-models-status",
      `已读取 ${entries.length} 个本地部署。可选择列表项，也可手动填写 ID。`,
    );
  },
  "local-models-status",
);
$("local-model-select").addEventListener("change", () => {
  const value = $<HTMLSelectElement>("local-model-select").value;
  if (value) {
    input("local-model").value = value;
    input("local-model").dispatchEvent(new Event("input", { bubbles: true }));
  }
});
function draft() {
  return {
    apiUrl: input("api-url").value,
    routing: input("routing").value,
    localUrl: input("local-url").value,
    localToken: input("local-token").value,
    clearLocalToken: input("clear-local-token").checked,
    localModel: input("local-model").value,
    localBackend: input("local-backend").value,
    localAutoStart: input("local-auto-start").checked,
    apiKey: input("api-key").value,
    clearKey: input("clear-key").checked,
    model: input("model").value,
    intervalMs: Number(input("interval").value) * 1000,
    timeoutMs: Number(input("timeout").value) * 1000,
    concurrency: Number(input("concurrency").value),
    batch: input("batch").checked,
  };
}
async function grant(url: string, trace = newTrace()) {
  const origin = new URL(url).origin;
  void record(trace, "permission.start", { outcome: "started" });
  const yes = await chrome.permissions.request({ origins: [origin + "/*"] });
  void record(trace, "permission.end", {
    outcome: yes ? "success" : "failed",
    reason: yes ? undefined : "PERMISSION_DENIED",
  });
  if (!yes) throw Error("请完成域名授权。");
}
bind("save", async (t: Trace) => {
  const { send, db } = scoped(t);

  const savedDraft = drafts.snapshot();
  const c = draft();
  if (c.routing !== "local-only") await grant(c.apiUrl, t);
  if (c.routing !== "cloud-only") await grant(c.localUrl, t);
  await send("SAVE", { config: c, trace: t });
  drafts.clear(serviceFields, savedDraft);
  show(await send("PRIVATE"));
  showStatus("status", "✓ 配置已保存，并回读核对。");
});
bind("reload-config", async (t: Trace) => {
  const { send, db } = scoped(t);

  if (
    drafts.any() &&
    !(await confirmAction("重新读取将放弃翻译服务中尚未保存的更改。"))
  )
    return;
  drafts.clear(serviceFields);
  show(await send("PRIVATE"));
  showStatus("status", "✓ 已重新读取配置。");
});
bind(
  "test",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    const c = draft();
    if (c.routing !== "local-only") await grant(c.apiUrl, t);
    if (c.routing !== "cloud-only") await grant(c.localUrl, t);
    showStatus("connection-test-status", "正在测试连接…");
    await send("TEST", { config: c, trace: t });
    showStatus("connection-test-status", "✓ 连接与译文校验成功。");
  },
  "connection-test-status",
);
bind(
  "reading-save",
  async (t) => {
    const { send } = scoped(t);
    await send("SAVE", { config: { mode: input("mode").value } });
    drafts.clear(["mode"]);
    showStatus("reading-status", "阅读方式已保存，下次翻译时生效。");
  },
  "reading-status",
);
for (const id of ["theme", "progress-visible"])
  input(id).addEventListener("change", () => {
    void runOperation("preferences", async (t) => {
      const { send } = scoped(t);
      const theme = input("theme").value;
      await send("PREFERENCES", {
        theme,
        visible: input("progress-visible").checked,
      });
      drafts.clear([id]);
      applyTheme(theme);
      showStatus("reading-status", "外观与进度显示已保存。");
    }).catch((e) => showStatus("reading-status", e.message));
  });
const serviceFields = [
  "api-url",
  "routing",
  "local-url",
  "local-token",
  "clear-local-token",
  "local-model",
  "local-backend",
  "local-auto-start",
  "api-key",
  "clear-key",
  "model",
  "interval",
  "timeout",
  "concurrency",
  "batch",
];
const human = (n: number) =>
  !Number.isFinite(n)
    ? "未知"
    : n >= 1024 * MiB
      ? (n / (1024 * MiB)).toFixed(2) + " GiB"
      : n >= MiB
        ? (n / MiB).toFixed(2) + " MiB"
        : n.toLocaleString() + " B";
async function stats(t = newTrace()) {
  const { db } = scoped(t);
  try {
    const s: CacheStatus = await db("status");
    $("cache-summary").replaceChildren();
    for (const [name, value] of [
      ["数据库占用", human(s.dbBytes)],
      ["待写入", s.pending == null ? "未知" : `${s.pending} 条`],
      ["写回状态", s.writeError ? "需要处理" : "就绪"],
    ]) {
      const item = document.createElement("div"),
        label = document.createElement("span"),
        number = document.createElement("strong");
      label.textContent = name;
      number.textContent = value;
      item.append(label, number);
      $("cache-summary").append(item);
    }
    showStatus(
      "db-stats",
      `SQLite / OPFS 已连接\n云端模型：${s.modelEntries?.toLocaleString() ?? "未知"} 条 · 本地模型：${s.localModelEntries?.toLocaleString() ?? "未知"} 条 / ${human(s.localModelBytes)}（上限 256 MiB）\n修订：${s.revisions?.toLocaleString() ?? "未知"} 条\n数据库：${human(s.dbBytes)} · 可复用空闲：${human(s.freeBytes)}\n压缩块：${human(s.blockBytes)} / 原始 ${human(s.rawBytes)}\n待写：${s.pending} 条 / ${human(s.pendingBytes)}${s.writeError ? "\n自动写回已暂停：" + s.writeError + "。腾出空间后点击立即提交重试。" : ""}\n热缓存 ${human(s.hotBytes)} · 解压块 ${human(s.decodedBytes)}\n本次 Worker 应用提交：${human(s.metrics.submittedBytes)}（不等于 SSD 物理擦写）\n维护提交：${human(s.metrics.maintenanceBytes)}`,
    );
    $("pack-list").replaceChildren();
    if (!s.packs.length)
      empty($("pack-list"), "暂无词库。导入后即可离线复用译文。");
    for (const p of s.packs) {
      const row = document.createElement("div");
      row.className = "pack";
      const label = document.createElement("p");
      label.textContent = `${p.enabled ? "已启用" : "已停用"} · ${p.id} · 当前 v${p.active} · 上一版 ${p.previous ? "v" + p.previous : "无"} · ${p.source_lang} → ${p.target_lang} · ${p.domain}`;
      row.append(label);
      for (const [title, op, confirm] of [
        ["回滚", "rollback", false],
        ["删除词库", "deletePack", true],
        ...(p.staging ? [["中止暂存 v" + p.staging, "abortPack", false]] : []),
      ] as [string, string, boolean][]) {
        const b = button("");
        b.textContent = title;
        b.disabled = op === "rollback" && (!p.previous || !!p.staging);
        b.onclick = (event) => {
          const control = event.currentTarget as HTMLButtonElement;
          if (control.disabled) return;
          control.disabled = true;
          void runOperation("list-action", async (t: Trace) => {
            const { send, db } = scoped(t);

            if (
              confirm &&
              !(await confirmAction(
                "删除 " + p.id + "？用户修订和其他词库不受影响。",
              ))
            )
              return;
            try {
              let r;
              do {
                r = await db(op, [p.id]);
                showStatus("pack-status", "正在分批处理 " + p.id);
              } while (r?.more);
              await stats(t);
            } catch (e) {
              showStatus("pack-status", (e as Error).message);
            }
          })
            .catch((e) => showStatus("pack-status", e.message))
            .finally(() => {
              control.disabled = false;
            });
        };
        row.append(b);
      }
      const toggle = button("");
      toggle.textContent = p.enabled ? "停用" : "启用";
      toggle.onclick = (event) => {
        const control = event.currentTarget as HTMLButtonElement;
        if (control.disabled) return;
        control.disabled = true;
        void runOperation("list-action", async (t: Trace) => {
          const { send, db } = scoped(t);

          await db("configurePack", [
            p.id,
            { enabled: !p.enabled, priority: p.priority },
          ]);
          await stats(t);
        })
          .catch((e) => showStatus("pack-status", e.message))
          .finally(() => {
            control.disabled = false;
          });
      };
      row.append(toggle);
      $("pack-list").append(row);
    }
  } catch (e) {
    showStatus(
      "db-stats",
      "缓存初始化未成功，已有数据保留。\n" + (e as Error).message,
    );
    throw e;
  }
}
bind("stats-refresh", stats, "storage-status");
bind(
  "budget-save",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    await send("SAVE", {
      config: { budgetBytes: Number(input("budget").value) * 1024 * MiB },
      trace: t,
    });
    drafts.clear(["budget"]);
    showStatus("storage-status", "预算已保存");
    await stats(t);
  },
  "storage-status",
);
bind(
  "flush",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    await db("flush");
    await stats(t);
  },
  "storage-status",
);
bind(
  "clear-model",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    if (!(await confirmAction("清理模型缓存？词库与用户修订将保留。"))) return;
    let r;
    do {
      r = await db("clearModels");
      showStatus("storage-status", "正在分批清理模型索引…");
    } while (r.more);
    await stats(t);
  },
  "storage-status",
);
bind(
  "collect",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    maintenance = true;
    maintenanceTrace = t;
    let total = 0;
    const trace = t;
    while (maintenance) {
      const r = await db("collect", [], trace);
      total += r.bytes;
      showStatus(
        "storage-status",
        `本轮维护提交 ${human(total)}；本小时剩余 ${human(r.budgetRemaining)}`,
      );
      if ((!r.bytes && !r.more) || !r.budgetRemaining) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    maintenance = false;
    await stats(t);
  },
  "storage-status",
);
$("collect-stop").onclick = () => {
  maintenance = false;
  const trace = maintenanceTrace || newTrace();
  void record(trace, "ui.cancel", {
    outcome: "cancelled",
    resourceId: "maintenance",
  });
  void db("maintenanceStop", [], trace).catch((e) =>
    showStatus("storage-status", e.message),
  );
  showStatus("storage-status", "当前批次完成后停止维护");
};
async function importStream(
  stream: ReadableStream<Uint8Array>,
  gzip: boolean,
  signal: AbortSignal,
  t: Trace,
) {
  let total = 0,
    limit = 32 * MiB;
  const decoded = gzip
    ? stream.pipeThrough(
        new DecompressionStream("gzip") as unknown as ReadableWritablePair<
          Uint8Array,
          Uint8Array
        >,
      )
    : stream;
  const bounded = decoded.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(c) {
        signal.addEventListener(
          "abort",
          () => c.error(Error("IMPORT_CANCELLED")),
          { once: true },
        );
      },
      transform(chunk, c) {
        total += chunk.byteLength;
        if (total > limit) throw Error("CONTAINER_DECOMPRESS_LIMIT");
        c.enqueue(chunk);
      },
    }),
  );
  const reader = lines(bounded, 32 * MiB);
  let manifest: PackManifest | undefined,
    started = false,
    n = 0;
  try {
    for await (const line of reader) {
      if (signal.aborted) throw Error("IMPORT_CANCELLED");
      const item = JSON.parse(line);
      if (!manifest) {
        manifest = item.manifest || item;
        limit =
          32 * MiB +
          manifest!.blocks.reduce(
            (sum, b) => sum + Math.ceil(b.bytes * 1.4) + 256,
            0,
          );
        await db("startPack", [manifest], t);
        started = true;
        showStatus(
          "pack-status",
          `已暂存 ${manifest!.id} v${manifest!.version}`,
        );
      } else {
        await db(
          "appendPack",
          [manifest.id, manifest.version, item.file, item.data],
          t,
        );
        n++;
        showStatus(
          "pack-status",
          `正在校验与导入 ${n}/${manifest.blocks.length} 块`,
        );
      }
    }
    if (!manifest) throw Error("EMPTY_PACK");
    if (signal.aborted) throw Error("IMPORT_CANCELLED");
    await db("activatePack", [manifest.id, manifest.version], t);
    showStatus("pack-status", `✓ ${manifest.id} v${manifest.version} 已激活`);
  } catch (e) {
    if (started && manifest) {
      try {
        await db("abortPack", [manifest.id], t);
      } catch {}
    }
    throw e;
  } finally {
    await reader.return(undefined);
    await stats(t);
  }
}
async function importingRun(
  run: (signal: AbortSignal, t: Trace) => Promise<void>,
  t = newTrace(),
) {
  if (importing) throw Error("已有导入在运行");
  importing = new AbortController();
  importTrace = t;
  const started = performance.now();
  await send("TRACE", {
    trace: t,
    event: "operation.start",
    fields: { outcome: "started", resourceId: "pack-import" },
  });
  try {
    await run(importing.signal, t);
    await send("TRACE", {
      trace: t,
      event: "operation.end",
      fields: {
        outcome: "success",
        resourceId: "pack-import",
        durationMs: performance.now() - started,
      },
    });
  } catch (e) {
    await send("TRACE", {
      trace: t,
      event: "operation.end",
      fields: {
        outcome: importing.signal.aborted ? "cancelled" : "failed",
        reason:
          e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
            ? e.message
            : "PACK_IMPORT_FAILED",
        resourceId: "pack-import",
        durationMs: performance.now() - started,
      },
    }).catch(() => {});
    throw e;
  } finally {
    importing = undefined;
  }
}
bind(
  "import-local",
  async (t: Trace) => {
    const { send, db } = scoped(t);
    return importingRun(async (signal, t) => {
      const file = input("pack-file").files?.[0];
      if (!file) throw Error("请选择词库文件");
      await importStream(file.stream(), file.name.endsWith(".gz"), signal, t);
    }, t);
  },
  "pack-status",
);
$("import-stop").onclick = () => {
  if (importing && importTrace)
    void record(importTrace, "ui.cancel", {
      outcome: "cancelled",
      resourceId: "pack-import",
    });
  importing?.abort();
};
async function sourceFetch(signal: AbortSignal, t: Trace) {
  const url = input("pack-url").value;
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password)
    throw Error("词库来源必须是无账号密码的 HTTPS 地址");
  await grant(url, t);
  const span = childTrace(t),
    start = performance.now(),
    requestId = crypto.randomUUID();
  await send("TRACE", {
    trace: span,
    event: "pack.http.start",
    fields: { outcome: "started", requestId },
  });
  try {
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "error",
      signal,
      headers: { traceparent: traceparent(span), "X-Request-ID": requestId },
    });
    await send("TRACE", {
      trace: span,
      event: "pack.http.end",
      fields: {
        outcome: response.ok ? "success" : "failed",
        status: response.status,
        requestId,
        durationMs: performance.now() - start,
      },
    });
    if (!response.ok || !response.body)
      throw Error("PACK_HTTP_" + response.status);
    return {
      response,
      gzip:
        u.pathname.endsWith(".gz") &&
        response.headers.get("content-encoding") !== "gzip",
    };
  } catch (e) {
    await send("TRACE", {
      trace: span,
      event: "pack.http.failed",
      fields: {
        outcome: signal.aborted ? "cancelled" : "failed",
        requestId,
        reason: "PACK_DOWNLOAD_FAILED",
        durationMs: performance.now() - start,
      },
    }).catch(() => {});
    throw e;
  }
}
bind(
  "source-save",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    const u = new URL(input("pack-url").value);
    if (u.protocol !== "https:") throw Error("仅支持 HTTPS");
    await chrome.storage.local.set({ "pack.source": u.href });
    drafts.clear(["pack-url"]);
    showStatus("pack-status", "来源已保存在本设备；更新仅手动发起");
  },
  "pack-status",
);
bind(
  "source-check",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    await send("TRACE", {
      trace: t,
      event: "operation.start",
      fields: { outcome: "started", resourceId: "pack-source-check" },
    });
    const controller = new AbortController();
    let outcome = "failed";
    try {
      const r = await sourceFetch(controller.signal, t);
      for await (const line of lines(
        r.gzip
          ? r.response.body!.pipeThrough(new DecompressionStream("gzip"))
          : r.response.body!,
      )) {
        const item = JSON.parse(line),
          m = item.manifest || item;
        showStatus(
          "pack-status",
          `${m.id} · v${m.version} · ${m.kind} · 基础版 ${m.baseVersion || "无"} · ${m.entries} 条（尚未导入）`,
        );
        break;
      }
      outcome = "success";
    } finally {
      controller.abort();
      await send("TRACE", {
        trace: t,
        event: "operation.end",
        fields: { outcome, resourceId: "pack-source-check" },
      });
    }
  },
  "pack-status",
);
bind(
  "import-url",
  async (t: Trace) => {
    const { send, db } = scoped(t);
    return importingRun(async (signal, t) => {
      const r = await sourceFetch(signal, t);
      await importStream(r.response.body!, r.gzip, signal, t);
    }, t);
  },
  "pack-status",
);
function revisionInput(): CacheInput {
  return {
    source: input("revision-source").value,
    domain: input("revision-domain").value.trim(),
    sourceLang: input("revision-language").value.trim(),
    targetLang: input("revision-target").value.trim(),
    scope: "",
  };
}
bind(
  "revision-save",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    await db("revision", [
      { ...revisionInput(), translation: input("revision-translation").value },
    ]);
    drafts.clear([
      "revision-language",
      "revision-target",
      "revision-domain",
      "revision-source",
      "revision-translation",
    ]);
    showStatus("revision-result", "修订已保存，将优先用于后续翻译。");
    await stats(t);
  },
  "revision-result",
);
bind(
  "revision-history",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    const rows = await db("revisionHistory", [revisionInput()]);
    $("revision-result").replaceChildren();
    if (!rows.length) empty($("revision-result"), "这段原文还没有修订历史。");
    for (const row of rows) {
      const line = document.createElement("div");
      const b = button("");
      b.textContent =
        "恢复 v" + row.revision + " · " + new Date(row.time).toLocaleString();
      b.onclick = () => {
        if (b.disabled) return;
        b.disabled = true;
        void runOperation("revision-restore", async (t) => {
          const { db } = scoped(t);
          const entry = await db("readRevision", [
            revisionInput(),
            row.revision,
          ]);
          await db("revision", [entry]);
          input("revision-translation").value = entry.translation;
          drafts.clear(["revision-translation"]);
          showStatus("revision-result", "已恢复为新修订版本");
        })
          .catch((e) => showStatus("revision-result", e.message))
          .finally(() => {
            b.disabled = false;
          });
      };
      line.append(b);
      $("revision-result").append(line);
    }
  },
  "revision-result",
);
bind(
  "revision-clear",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    if (!(await confirmAction("清除全部用户修订及其历史？此操作不能撤销。")))
      return;
    let r;
    do {
      r = await db("clearRevisions");
    } while (r.more);
    await stats(t);
  },
  "revision-result",
);
let traceOffset = 0;
async function traceRead(all = false, t = newTrace()) {
  const { send } = scoped(t);
  const r: TracePage = await send("TRACE_READ", {
    traceId: input("trace-id").value.trim(),
    batchId: input("batch-id").value.trim(),
    ...(all ? {} : { limit: 200, offset: traceOffset }),
  });
  if (!all)
    records(
      $("trace-results"),
      [...r.events].reverse(),
      (e) =>
        `${new Date(e.time).toLocaleString()} · ${e.event} · ${e.outcome}${e.durationMs == null ? "" : ` · ${e.durationMs} ms`}`,
      "没有匹配的诊断记录。",
    );
  showStatus(
    "trace-summary",
    `${all ? "导出" : `第 ${Math.floor(traceOffset / 200) + 1} 页，最近优先`} ${r.events.length} 条 · 内存待提交 ${r.stats.pending} 条 · 诊断提交 ${r.stats.flushes} 次 / ${human(r.stats.diagnosticSubmittedBytes as number)} · 丢弃 ${r.stats.dropped} 条；供应商无请求 ID 时不可关联`,
  );
  if (!all) {
    $<HTMLButtonElement>("trace-newer").disabled = traceOffset === 0;
    $<HTMLButtonElement>("trace-older").disabled = r.events.length < 200;
    $("trace-newer").dataset.unavailable = String(traceOffset === 0);
    $("trace-older").dataset.unavailable = String(r.events.length < 200);
  }
  return r;
}
bind(
  "trace-search",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    traceOffset = 0;
    return traceRead(false, t);
  },
  "trace-summary",
);
bind(
  "trace-newer",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    traceOffset = Math.max(0, traceOffset - 200);
    return traceRead(false, t);
  },
  "trace-summary",
);
bind(
  "trace-older",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    traceOffset += 200;
    return traceRead(false, t);
  },
  "trace-summary",
);
bind(
  "trace-clear",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    await send("TRACE_CLEAR");
    traceOffset = 0;
    await traceRead(false, t);
  },
  "trace-summary",
);
bind(
  "trace-export",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    const r = await traceRead(true, t);
    const a = document.createElement("a"),
      url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              {
                format: "qingyi-trace-v1",
                exportedAt: new Date().toISOString(),
                ...r,
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
      );
    a.href = url;
    a.download = "qingyi-diagnostics-" + Date.now() + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },
  "trace-summary",
);
bind(
  "release-check",
  async (t: Trace) => {
    const { send } = scoped(t);
    showStatus("release-result", "正在检查更新…");
    const r = await send("RELEASE");
    renderRelease($("release-result"), r);
  },
  "release-result",
);
function releaseError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code.includes("INVALID_REPOSITORY"))
    return "更新源格式不正确。请填写 owner/repo，或点击“恢复官方源”。";
  if (
    code.includes("RELEASE_RATE_LIMITED") ||
    code.includes("RELEASE_HTTP_429")
  )
    return "GitHub 请求次数已达上限，请稍后点击“检查更新”重试。";
  if (code.includes("RELEASE_HTTP_404"))
    return "未找到仓库或已发布版本。请检查自定义更新源，或恢复官方源后重试。";
  if (/RELEASE_HTTP_40[13]|PERMISSION|OPTIONS_PAGE_REQUIRED/.test(code))
    return "更新请求被拒绝。请检查浏览器授权或网络访问限制，再重试。";
  if (/INVALID_RELEASE|EMPTY_RELEASE|DECOMPRESS_LIMIT/.test(code))
    return "更新源返回的版本信息不完整。请稍后重试，或恢复官方源。";
  return "暂时无法连接更新源。请检查网络后重试；已保存的设置保持不变。";
}
for (const [id, reset] of [
  ["release-save", false],
  ["release-reset", true],
] as const) {
  bind(
    id,
    async (trace) => {
      const value = reset
        ? DEFAULTS.releaseRepo
        : input("release-repo").value.trim() || DEFAULTS.releaseRepo;
      const saved = drafts.snapshot();
      const c = await scoped(trace).send("SAVE", {
        config: { releaseRepo: value },
      });
      drafts.clear(["release-repo"], saved);
      if (!drafts.has("release-repo"))
        input("release-repo").value = c.releaseRepo;
      config.releaseRepo = c.releaseRepo;
      $("release-source").textContent = "当前更新源：" + c.releaseRepo;
      showStatus(
        "release-source-status",
        reset ? "已恢复官方更新源。" : "更新源已保存。",
      );
    },
    "release-source-status",
  );
}
bind(
  "migrate",
  async (t: Trace) => {
    const { send, db } = scoped(t);

    const r = await send("MIGRATE", { code: input("migration-code").value });
    input("migration-code").value = "";
    show(await send("PRIVATE"));
    showStatus(
      "migration-status",
      `✓ 已迁移，Key ${r.hasKey ? "已保留" : "未配置"}；${r.cacheBuckets} 个旧缓存分区。请重新保存并授权 API 地址。`,
    );
    await stats(t);
  },
  "migration-status",
);
void runOperation("settings-load", async (t) => {
  const { send } = scoped(t);
  show(await send("PRIVATE"));
  const d = await chrome.storage.local.get("pack.source");
  input("pack-url").value = d["pack.source"] || "";
}).catch((e) => showStatus("status", e.message));
const loaded = new Set<string>();
const pages: Record<string, [string, string]> = {
  service: ["翻译服务", "选择文字的去向，保留阅读的节奏。"],
  reading: ["阅读与网站", "让翻译按你的阅读习惯出现。"],
  storage: ["本地缓存", "查看空间与写回状态，按需维护。"],
  packs: ["词库与修订", "让可靠的译文在下一次阅读中复用。"],
  diagnostic: ["诊断", "从一次操作追溯结果，按需展开技术详情。"],
  update: ["更新与迁移", "检查版本，保留本机的配置与数据。"],
};
function loadSection() {
  const name = location.hash.slice(1) || "service",
    selected = pages[name] ? name : "service";
  for (const page of document.querySelectorAll<HTMLElement>("main > .page"))
    page.hidden = page.id !== selected;
  for (const link of document.querySelectorAll<HTMLAnchorElement>("nav a")) {
    if (link.hash === "#" + selected) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("page-title").textContent = pages[selected][0];
  $("page-summary").textContent = pages[selected][1];
  if (["storage", "packs"].includes(selected) && !loaded.has(selected)) {
    loaded.add(selected);
    void runOperation("load-" + selected, stats).catch((e) => {
      loaded.delete(selected);
      showStatus(
        selected === "packs" ? "pack-status" : "storage-status",
        e.message,
      );
    });
  }
}
addEventListener("hashchange", loadSection);
document.addEventListener("input", () => {
  $("draft-state").hidden = !drafts.any();
});
window.addEventListener("beforeunload", (e) => {
  if (drafts.any()) {
    e.preventDefault();
    e.returnValue = "";
  }
});
loadSection();
