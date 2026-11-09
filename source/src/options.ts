import { newTrace, childTrace, traceparent } from "./trace";
import { MiB, type Trace, type CacheInput, type PackManifest } from "./types";
import { lines } from "./codec";
import { renderRelease } from "./releases-view";
import { singleTextModel } from "./model-profile";
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
let config: any;
let importing: AbortController | undefined,
  maintenance = false;
async function send(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let r;
  try {
    const response = chrome.runtime.sendMessage({ type, ...payload });
    r =
      type === "PRIVATE"
        ? await Promise.race([
            response,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    Error(
                      "后台未响应，请在浏览器扩展管理页重新启用轻译，再点击重新读取配置。",
                    ),
                  ),
                10000,
              );
            }),
          ])
        : await response;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!r?.ok) throw Error(r?.error || "EXTENSION_UNAVAILABLE");
  return r.data;
}
const db = (operation: string, args: unknown[] = [], trace = newTrace()) =>
  send("DATABASE", { operation, args, trace });
function showStatus(id: string, value: unknown) {
  $(id).textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function bind(id: string, action: () => Promise<unknown>, status = "status") {
  const button = $<HTMLButtonElement>(id);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await action();
    } catch (e) {
      showStatus(status, e instanceof Error ? e.message : "操作失败");
    } finally {
      button.disabled = button.dataset.unavailable === "true";
    }
  });
}
function show(c: any) {
  config = c;
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
    const button = document.createElement("button");
    button.textContent = "关闭自动翻译";
    button.onclick = async () => {
      await send("REMOVE_SITE", { origin: site });
      show(await send("PRIVATE"));
    };
    row.append(text, button);
    $("sites").append(row);
  }
}
function modelHint() {
  $("model-hint").textContent = singleTextModel(input("model").value)
    ? "Hunyuan-MT 按段翻译。需要批量时，可选择支持 JSON 输出的对话模型；缓存命中不受影响。"
    : "批量模式需要模型支持按编号返回 JSON 译文；不支持时会缩小批次重试。";
}
input("model").addEventListener("input", modelHint);
bind("refresh-local-models", async () => {
  await grant(input("local-url").value);
  const entries = await send("LOCAL_MODELS", {
    config: draft(),
    trace: newTrace(),
  });
  const select = $<HTMLSelectElement>("local-model-select"),
    list = $("local-model-list");
  select.replaceChildren();
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
    "status",
    `已读取 ${entries.length} 个本地部署。可选择列表项，也可手动填写 ID。`,
  );
});
$("local-model-select").addEventListener("change", () => {
  input("local-model").value = $<HTMLSelectElement>("local-model-select").value;
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
    mode: input("mode").value,
    batch: input("batch").checked,
    budgetBytes: Number(input("budget").value) * 1024 * MiB,
    releaseRepo: input("release-repo").value.trim(),
  };
}
async function grant(url: string) {
  const origin = new URL(url).origin;
  const yes = await chrome.permissions.request({ origins: [origin + "/*"] });
  if (!yes) throw Error("请完成域名授权。");
}
bind("save", async () => {
  const c = draft();
  if (c.routing !== "local-only") await grant(c.apiUrl);
  if (c.routing !== "cloud-only") await grant(c.localUrl);
  await send("SAVE", { config: c, trace: newTrace() });
  show(await send("PRIVATE"));
  showStatus("status", "✓ 配置已保存，并回读核对。");
});
bind("reload-config", async () => {
  show(await send("PRIVATE"));
  showStatus("status", "✓ 已重新读取配置。");
});
bind("test", async () => {
  const c = draft();
  if (c.routing !== "local-only") await grant(c.apiUrl);
  if (c.routing !== "cloud-only") await grant(c.localUrl);
  showStatus("status", "正在测试连接…");
  await send("TEST", { config: c, trace: newTrace() });
  showStatus("status", "✓ 连接与译文校验成功。");
});
input("progress-visible").addEventListener("change", () => {
  void send("DISPLAY", { visible: input("progress-visible").checked }).catch(
    (e) => showStatus("status", e.message),
  );
});
const human = (n: number) =>
  n >= 1024 * MiB
    ? (n / (1024 * MiB)).toFixed(2) + " GiB"
    : n >= MiB
      ? (n / MiB).toFixed(2) + " MiB"
      : n.toLocaleString() + " B";
async function stats() {
  try {
    const s = await db("status");
    showStatus(
      "db-stats",
      `SQLite / OPFS 已连接\n云端模型：${s.modelEntries.toLocaleString()} 条 · 本地模型：${s.localModelEntries.toLocaleString()} 条 / ${human(s.localModelBytes)}（上限 256 MiB）\n修订：${s.revisions.toLocaleString()} 条\n数据库：${human(s.dbBytes)} · 可复用空闲：${human(s.freeBytes)}\n压缩块：${human(s.blockBytes)} / 原始 ${human(s.rawBytes)}\n待写：${s.pending} 条 / ${human(s.pendingBytes)}${s.writeError ? "\n自动写回已暂停：" + s.writeError + "。腾出空间后点击立即提交重试。" : ""}\n热缓存 ${human(s.hotBytes)} · 解压块 ${human(s.decodedBytes)}\n本次 Worker 应用提交：${human(s.metrics.submittedBytes)}（不等于 SSD 物理擦写）\n维护提交：${human(s.metrics.maintenanceBytes)}`,
    );
    $("pack-list").replaceChildren();
    for (const p of s.packs) {
      const row = document.createElement("div");
      row.className = "pack";
      const label = document.createElement("p");
      label.textContent = `${p.id} · 当前 v${p.active} · 上一版 ${p.previous ? "v" + p.previous : "无"} · ${p.source_lang} → ${p.target_lang} · ${p.domain}`;
      row.append(label);
      for (const [title, op, confirm] of [
        ["回滚", "rollback", false],
        ["删除词库", "deletePack", true],
        ...(p.staging ? [["中止暂存 v" + p.staging, "abortPack", false]] : []),
      ] as [string, string, boolean][]) {
        const b = document.createElement("button");
        b.textContent = title;
        b.onclick = async () => {
          if (
            confirm &&
            !window.confirm("删除 " + p.id + "？用户修订和其他词库不受影响。")
          )
            return;
          try {
            let r;
            do {
              r = await db(op, [p.id]);
              showStatus("pack-status", "正在分批处理 " + p.id);
            } while (r?.more);
            await stats();
          } catch (e) {
            showStatus("pack-status", (e as Error).message);
          }
        };
        row.append(b);
      }
      const toggle = document.createElement("button");
      toggle.textContent = p.enabled ? "停用" : "启用";
      toggle.onclick = async () => {
        await db("configurePack", [
          p.id,
          { enabled: !p.enabled, priority: p.priority },
        ]);
        await stats();
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
  async () => {
    await send("SAVE", {
      config: { budgetBytes: Number(input("budget").value) * 1024 * MiB },
      trace: newTrace(),
    });
    showStatus("storage-status", "预算已保存");
    await stats();
  },
  "storage-status",
);
bind(
  "flush",
  async () => {
    await db("flush");
    await stats();
  },
  "storage-status",
);
bind(
  "clear-model",
  async () => {
    if (!confirm("清理模型缓存？词库与用户修订将保留。")) return;
    let r;
    do {
      r = await db("clearModels");
      showStatus("storage-status", "正在分批清理模型索引…");
    } while (r.more);
    await stats();
  },
  "storage-status",
);
bind(
  "collect",
  async () => {
    maintenance = true;
    let total = 0;
    const trace = newTrace();
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
    await stats();
  },
  "storage-status",
);
$("collect-stop").onclick = () => {
  maintenance = false;
  void db("maintenanceStop").catch((e) =>
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
    await stats();
  }
}
async function importingRun(
  run: (signal: AbortSignal, t: Trace) => Promise<void>,
) {
  if (importing) throw Error("已有导入在运行");
  importing = new AbortController();
  const t = newTrace(),
    started = performance.now();
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
  () =>
    importingRun(async (signal, t) => {
      const file = input("pack-file").files?.[0];
      if (!file) throw Error("请选择词库文件");
      await importStream(file.stream(), file.name.endsWith(".gz"), signal, t);
    }),
  "pack-status",
);
$("import-stop").onclick = () => importing?.abort();
async function sourceFetch(signal: AbortSignal, t: Trace) {
  const url = input("pack-url").value;
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password)
    throw Error("词库来源必须是无账号密码的 HTTPS 地址");
  await grant(url);
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
  async () => {
    const u = new URL(input("pack-url").value);
    if (u.protocol !== "https:") throw Error("仅支持 HTTPS");
    await chrome.storage.local.set({ "pack.source": u.href });
    showStatus("pack-status", "来源已保存在本设备；更新仅手动发起");
  },
  "pack-status",
);
bind(
  "source-check",
  async () => {
    const t = newTrace();
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
  () =>
    importingRun(async (signal, t) => {
      const r = await sourceFetch(signal, t);
      await importStream(r.response.body!, r.gzip, signal, t);
    }),
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
  async () => {
    showStatus(
      "revision-result",
      await db("revision", [
        {
          ...revisionInput(),
          translation: input("revision-translation").value,
        },
      ]),
    );
    await stats();
  },
  "revision-result",
);
bind(
  "revision-history",
  async () => {
    const rows = await db("revisionHistory", [revisionInput()]);
    $("revision-result").replaceChildren();
    for (const row of rows) {
      const line = document.createElement("div");
      const b = document.createElement("button");
      b.textContent =
        "恢复 v" + row.revision + " · " + new Date(row.time).toLocaleString();
      b.onclick = async () => {
        try {
          const entry = await db("readRevision", [
            revisionInput(),
            row.revision,
          ]);
          await db("revision", [entry]);
          input("revision-translation").value = entry.translation;
          showStatus("revision-result", "已恢复为新修订版本");
        } catch (e) {
          showStatus("revision-result", (e as Error).message);
        }
      };
      line.append(b);
      $("revision-result").append(line);
    }
  },
  "revision-result",
);
bind(
  "revision-clear",
  async () => {
    if (!confirm("清除全部用户修订及其历史？此操作不能撤销。")) return;
    let r;
    do {
      r = await db("clearRevisions");
    } while (r.more);
    await stats();
  },
  "revision-result",
);
let traceOffset = 0;
async function traceRead(all = false) {
  const r = await send("TRACE_READ", {
    traceId: input("trace-id").value.trim(),
    batchId: input("batch-id").value.trim(),
    ...(all ? {} : { limit: 200, offset: traceOffset }),
  });
  if (!all) showStatus("trace-results", r.events);
  showStatus(
    "trace-summary",
    `${all ? "导出" : `第 ${Math.floor(traceOffset / 200) + 1} 页，最近优先`} ${r.events.length} 条 · 内存待提交 ${r.stats.pending} 条 · 诊断提交 ${r.stats.flushes} 次 / ${human(r.stats.diagnosticSubmittedBytes || 0)} · 丢弃 ${r.stats.dropped} 条；供应商无请求 ID 时不可关联`,
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
  async () => {
    traceOffset = 0;
    return traceRead();
  },
  "trace-summary",
);
bind(
  "trace-newer",
  async () => {
    traceOffset = Math.max(0, traceOffset - 200);
    return traceRead();
  },
  "trace-summary",
);
bind(
  "trace-older",
  async () => {
    traceOffset += 200;
    return traceRead();
  },
  "trace-summary",
);
bind(
  "trace-clear",
  async () => {
    await send("TRACE_CLEAR");
    traceOffset = 0;
    await traceRead();
  },
  "trace-summary",
);
bind(
  "trace-export",
  async () => {
    const r = await traceRead(true);
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
  async () => {
    await send("SAVE", {
      config: { releaseRepo: input("release-repo").value.trim() },
    });
    const r = await send("RELEASE", {
      repo: input("release-repo").value.trim(),
    });
    renderRelease($("release-result"), r);
  },
  "release-result",
);
bind(
  "migrate",
  async () => {
    const r = await send("MIGRATE", { code: input("migration-code").value });
    input("migration-code").value = "";
    show(await send("PRIVATE"));
    showStatus(
      "migration-status",
      `✓ 已迁移，Key ${r.hasKey ? "已保留" : "未配置"}；${r.cacheBuckets} 个旧缓存分区。请重新保存并授权 API 地址。`,
    );
    await stats();
  },
  "migration-status",
);
void (async () => {
  show(await send("PRIVATE"));
  const d = await chrome.storage.local.get("pack.source");
  input("pack-url").value = d["pack.source"] || "";
})().catch((e) => showStatus("status", e.message));
let storageLoaded = false;
function loadSection() {
  if (!storageLoaded && ["#storage", "#packs"].includes(location.hash)) {
    storageLoaded = true;
    void stats();
  }
}
addEventListener("hashchange", loadSection);
loadSection();
