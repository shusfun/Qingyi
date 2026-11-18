import { useEffect, useRef, useState } from "preact/hooks";
import {
  Badge,
  Button,
  DataList,
  FeedbackBanner,
  Switch,
  TextInput,
  Textarea,
  VerdictHero,
  confirmAction,
  feedbackStore,
  resolveError,
  runTracked,
  toast,
  useFeedbackStore,
  type UiLang,
} from "../../design-system";
import { lines } from "../codec";
import { childTrace, newTrace, traceparent } from "../trace";
import { MiB, type CacheInput, type PackManifest } from "../types";
import { grantOriginsOnce, recordTrace, runTracedUiOp, scopedRpc } from "./rpc";
import type { CacheStatus, PackView, SettingsView } from "./types";

export function PacksSection({
  config,
  packUrlDraft,
  setPackUrlDraft,
  onSavedPackUrl,
  cacheStatus,
  onRefreshCache,
  onSavedConfig,
  lang,
}: {
  config: SettingsView;
  packUrlDraft: string;
  setPackUrlDraft: (v: string) => void;
  onSavedPackUrl: (v: string) => void;
  cacheStatus: CacheStatus | null;
  onRefreshCache: () => Promise<void>;
  onSavedConfig: (next: SettingsView) => void;
  lang: UiLang;
}) {
  const store = useFeedbackStore();
  const en = lang === "en";
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const importTraceRef = useRef(newTrace());
  const [importing, setImporting] = useState(false);

  // User Revision form & snapshot-bound history state (fixes Q-18 & Q-10)
  const [revSourceLang, setRevSourceLang] = useState("en");
  const [revTargetLang, setRevTargetLang] = useState(
    config.targetLang || "zh-CN",
  );
  const [revDomain, setRevDomain] = useState("*");
  const [revSource, setRevSource] = useState("");
  const [revTranslation, setRevTranslation] = useState("");
  const [historyRows, setHistoryRows] = useState<
    { revision: number; time: number; trace_id: string }[] | null
  >(null);
  const [historySnapshotInput, setHistorySnapshotInput] =
    useState<CacheInput | null>(null);

  useEffect(() => {
    if (!cacheStatus) {
      void onRefreshCache();
    }
  }, []);

  // Q-18: Clear stale revision history list whenever revision key fields change!
  const invalidateHistoryIfChanged = () => {
    if (historyRows !== null) {
      setHistoryRows(null);
      setHistorySnapshotInput(null);
    }
  };

  const currentRevisionInput = (): CacheInput => ({
    source: revSource,
    domain: revDomain.trim() || "*",
    sourceLang: revSourceLang.trim() || "auto",
    targetLang: revTargetLang.trim() || "zh-CN",
    scope: "",
  });

  const importPackStream = async (
    stream: ReadableStream<Uint8Array>,
    gzip: boolean,
    signal: AbortSignal,
    t = newTrace(),
  ) => {
    const rpc = scopedRpc(t);
    let total = 0;
    let limit = 32 * MiB;
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
            () => c.error(new Error("IMPORT_CANCELLED")),
            { once: true },
          );
        },
        transform(chunk, c) {
          total += chunk.byteLength;
          if (total > limit) throw new Error("CONTAINER_DECOMPRESS_LIMIT");
          c.enqueue(chunk);
        },
      }),
    );
    const reader = lines(bounded, 32 * MiB);
    let manifest: PackManifest | undefined;
    let started = false;
    let blockIdx = 0;
    try {
      for await (const line of reader) {
        if (signal.aborted) throw new Error("IMPORT_CANCELLED");
        const item = JSON.parse(line);
        if (!manifest) {
          manifest = item.manifest || item;
          limit =
            32 * MiB +
            manifest!.blocks.reduce(
              (sum, b) => sum + Math.ceil(b.bytes * 1.4) + 256,
              0,
            );
          await rpc.db("startPack", [manifest], t);
          started = true;
          feedbackStore.setBanner("packs", {
            tone: "info",
            message: en
              ? `Staged ${manifest!.id} v${manifest!.version}…`
              : `已暂存词库 ${manifest!.id} v${manifest!.version}，正在导入数据块…`,
            autoDismissMs: 0,
          });
        } else {
          await rpc.db(
            "appendPack",
            [manifest.id, manifest.version, item.file, item.data],
            t,
          );
          blockIdx++;
          feedbackStore.setBanner("packs", {
            tone: "info",
            message: en
              ? `Importing & verifying block ${blockIdx}/${manifest.blocks.length}…`
              : `正在校验与导入第 ${blockIdx} / ${manifest.blocks.length} 块…`,
            autoDismissMs: 0,
          });
        }
      }
      if (!manifest) throw new Error("EMPTY_PACK");
      if (signal.aborted) throw new Error("IMPORT_CANCELLED");
      await rpc.db("activatePack", [manifest.id, manifest.version], t);
      feedbackStore.setBanner("packs", {
        tone: "success",
        message: en
          ? `Activated ${manifest.id} v${manifest.version}.`
          : `词库 ${manifest.id} v${manifest.version} 已校验并激活生效。`,
      });
    } catch (e) {
      if (started && manifest) {
        try {
          await rpc.db("abortPack", [manifest.id], t);
        } catch {
          // ignore partial abort; user can finish aborting from pack list
        }
      }
      throw e;
    } finally {
      await reader.return(undefined);
      await onRefreshCache();
    }
  };

  // Q-31, Q-13, Q-50: Shared import lock disabling both buttons, neutral cancellation, case-insensitive .gz + input reset
  const executeImport = async (
    modeName: string,
    runner: (
      signal: AbortSignal,
      t: ReturnType<typeof newTrace>,
    ) => Promise<void>,
  ) => {
    if (importing) {
      feedbackStore.reportError("packs", new Error("IMPORT_IN_PROGRESS"), lang);
      return;
    }
    const ac = new AbortController();
    const t = newTrace();
    importAbortRef.current = ac;
    importTraceRef.current = t;
    setImporting(true);
    try {
      await runTracedUiOp(modeName, () => runner(ac.signal, t), t);
    } catch (err) {
      const resolved = resolveError(err, lang);
      if (resolved.isCancelled || ac.signal.aborted) {
        feedbackStore.setBanner("packs", {
          tone: "info",
          message: resolved.message,
        });
      } else {
        feedbackStore.reportError("packs", err, lang);
      }
    } finally {
      setImporting(false);
      importAbortRef.current = null;
    }
  };

  const fetchPackSource = async (
    signal: AbortSignal,
    t: ReturnType<typeof newTrace>,
  ) => {
    const raw = packUrlDraft.trim();
    if (!raw) throw new Error("INVALID_ENDPOINT");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error("INVALID_ENDPOINT");
    }
    if (u.protocol !== "https:" || u.username || u.password) {
      throw new Error("HTTPS_REQUIRED");
    }
    await grantOriginsOnce([u.href], t);
    const span = childTrace(t);
    const requestId = crypto.randomUUID();
    const start = performance.now();
    await recordTrace(span, "pack.http.start", {
      outcome: "started",
      requestId,
    });
    const response = await fetch(u.href, {
      credentials: "omit",
      redirect: "error",
      signal,
      headers: { traceparent: traceparent(span), "X-Request-ID": requestId },
    });
    await recordTrace(span, "pack.http.end", {
      outcome: response.ok ? "success" : "failed",
      status: response.status,
      requestId,
      durationMs: performance.now() - start,
    });
    if (!response.ok || !response.body) {
      throw new Error("PACK_HTTP_" + response.status);
    }
    return {
      response,
      gzip:
        /\.gz$/i.test(u.pathname) &&
        response.headers.get("content-encoding") !== "gzip",
    };
  };

  const handleImportLocalFile = () =>
    executeImport("pack-import-local", async (signal, t) => {
      const file = fileInputRef.current?.files?.[0];
      if (!file) {
        throw new Error("请选择词库文件");
      }
      const isGzip = /\.gz$/i.test(file.name);
      await importPackStream(file.stream(), isGzip, signal, t);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    });

  const handleImportRemoteUrl = () =>
    executeImport("pack-import-url", async (signal, t) => {
      const r = await fetchPackSource(signal, t);
      await importPackStream(r.response.body!, r.gzip, signal, t);
    });

  const handleCancelImport = () => {
    if (!importing || !importAbortRef.current) return;
    void recordTrace(importTraceRef.current, "ui.cancel", {
      outcome: "cancelled",
      resourceId: "pack-import",
    });
    importAbortRef.current.abort();
  };

  // Q-32 & Q-11: Per-pack busy key disables all buttons on that pack row, confirms destructive ops, and reports terminal state!
  const handlePackRowAction = async (
    pack: PackView,
    op: "rollback" | "deletePack" | "abortPack" | "toggle",
  ) => {
    if (op === "deletePack") {
      const ok = await confirmAction({
        message: en
          ? `Delete dictionary pack "${pack.id}"? User revisions and other packs will not be affected.`
          : `确定删除词库「${pack.id}」吗？用户人工修订与其他词库不受影响。`,
        danger: true,
        lang,
      });
      if (!ok) return;
    } else if (op === "rollback") {
      const ok = await confirmAction({
        message: en
          ? `Roll "${pack.id}" back to version v${pack.previous}?`
          : `确定将词库「${pack.id}」回滚至上一版本 v${pack.previous} 吗？`,
        lang,
      });
      if (!ok) return;
    } else if (op === "abortPack") {
      const ok = await confirmAction({
        message: en
          ? `Discard staged version v${pack.staging} of "${pack.id}"?`
          : `确定中止并清理词库「${pack.id}」未完成的暂存版本 v${pack.staging} 吗？`,
        danger: true,
        lang,
      });
      if (!ok) return;
    }

    await runTracked(
      { key: `pack:${pack.id}`, scope: "packs", lang },
      async () => {
        if (op === "toggle") {
          await runTracedUiOp("pack-toggle", async (t) => {
            await scopedRpc(t).db("configurePack", [
              pack.id,
              { enabled: !pack.enabled, priority: pack.priority },
            ]);
            await onRefreshCache();
          });
          toast(
            pack.enabled
              ? en
                ? `Disabled pack ${pack.id}.`
                : `已停用词库 ${pack.id}。`
              : en
                ? `Enabled pack ${pack.id}.`
                : `已启用词库 ${pack.id}。`,
            "success",
          );
          return;
        }

        feedbackStore.setBanner("packs", {
          tone: "info",
          message: en
            ? `Processing ${pack.id}…`
            : `正在分批处理词库 ${pack.id}…`,
          autoDismissMs: 0,
        });
        await runTracedUiOp(`pack-${op}`, async (t) => {
          const rpc = scopedRpc(t);
          let more = true;
          while (more) {
            const r = await rpc.db<{ more?: boolean }>(op, [pack.id]);
            more = Boolean(r?.more);
          }
          await onRefreshCache();
        });
        feedbackStore.setBanner("packs", {
          tone: "success",
          message:
            op === "deletePack"
              ? en
                ? `Deleted dictionary pack ${pack.id}.`
                : `已删除词库 ${pack.id}。`
              : op === "rollback"
                ? en
                  ? `Rolled ${pack.id} back to v${pack.previous}.`
                  : `已将词库 ${pack.id} 回滚至 v${pack.previous}。`
                : en
                  ? `Aborted staging version for ${pack.id}.`
                  : `已清理 ${pack.id} 的暂存记录。`,
        });
      },
    );
  };

  const syncStatus = config["sync.status"];

  return (
    <section class="page panel">
      <VerdictHero
        eyebrow={en ? "DICTIONARIES & REVISIONS" : "词库、修订与本地同步"}
        title={
          (cacheStatus?.packs.length || 0) > 0 ||
          (cacheStatus?.revisions || 0) > 0
            ? en
              ? `${cacheStatus?.packs.length || 0} dictionary pack(s) · ${cacheStatus?.revisions ?? 0} user revision(s)`
              : `已安装 ${cacheStatus?.packs.length || 0} 个离线词库 · ${cacheStatus?.revisions ?? 0} 条用户修订优先命中`
            : en
              ? "Import offline dictionary packs or save custom revisions"
              : "导入压缩词库或保存人工修订，命中时无需请求模型"
        }
        badge={
          <Badge tone="neutral">
            {config.syncDictionary
              ? en
                ? "Sync to mistral-gui ON"
                : "已开启同步至 mistral-gui"
              : en
                ? "Browser Local"
                : "浏览器本地存储"}
          </Badge>
        }
        metrics={[
          {
            label: en ? "Active Packs" : "已启用词库",
            value: String(
              (cacheStatus?.packs || []).filter((p) => p.enabled).length,
            ),
          },
          {
            label: en ? "Revisions" : "人工修订",
            value:
              cacheStatus?.revisions == null
                ? en
                  ? "Unknown"
                  : "未知"
                : String(cacheStatus.revisions),
          },
          {
            label: en ? "Last Sync" : "最近同步",
            value: syncStatus?.syncedAt
              ? new Date(syncStatus.syncedAt).toLocaleTimeString()
              : en
                ? "Never"
                : "尚未同步",
          },
        ]}
      />

      <FeedbackBanner scope="packs" lang={lang} />

      <fieldset>
        <legend>
          {en ? "Import Dictionary Pack" : "导入离线词库包（qingyi-pack-v1）"}
        </legend>
        <div class="grid">
          <div class="field">
            <span>
              {en
                ? "Local .jsonl / .gz pack file"
                : "选择本地词库文件（支持 .jsonl / .gz）"}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".jsonl,.gz,.ndjson,application/gzip"
              disabled={importing}
            />
          </div>
          <TextInput
            label={en ? "Remote HTTPS pack URL" : "远程 HTTPS 词库地址"}
            type="url"
            placeholder="https://example.com/qingyi-pack.jsonl.gz"
            value={packUrlDraft}
            disabled={importing}
            onValueInput={(v) => setPackUrlDraft(v)}
          />
        </div>
        <div class="actions">
          <Button
            variant="primary"
            busy={importing}
            disabled={importing}
            onClick={() => void handleImportLocalFile()}
          >
            {en ? "Import local file" : "导入本地文件"}
          </Button>
          <Button
            busy={importing}
            disabled={importing}
            onClick={() => void handleImportRemoteUrl()}
          >
            {en ? "Download & import URL" : "下载并导入"}
          </Button>
          <Button disabled={!importing} onClick={handleCancelImport}>
            {en ? "Cancel import" : "取消导入"}
          </Button>
          <Button
            disabled={importing}
            busy={store.isBusy("packs:source-save")}
            onClick={() =>
              runTracked(
                { key: "packs:source-save", scope: "packs", lang },
                async () => {
                  const raw = packUrlDraft.trim();
                  let u: URL;
                  try {
                    u = new URL(raw);
                  } catch {
                    throw new Error("INVALID_ENDPOINT");
                  }
                  if (u.protocol !== "https:")
                    throw new Error("HTTPS_REQUIRED");
                  await chrome.storage.local.set({ "pack.source": u.href });
                  onSavedPackUrl(u.href);
                  toast(
                    en
                      ? "Saved HTTPS pack source URL."
                      : "词库来源地址已保存（仅手动触发更新）。",
                    "success",
                  );
                },
              )
            }
          >
            {en ? "Save URL" : "保存来源地址"}
          </Button>
          <Button
            disabled={importing}
            busy={store.isBusy("packs:source-check")}
            onClick={() =>
              runTracked(
                { key: "packs:source-check", scope: "packs", lang },
                async () => {
                  const ac = new AbortController();
                  await runTracedUiOp("pack-source-check", async (t) => {
                    try {
                      const r = await fetchPackSource(ac.signal, t);
                      for await (const line of lines(
                        r.gzip
                          ? r.response.body!.pipeThrough(
                              new DecompressionStream("gzip"),
                            )
                          : r.response.body!,
                      )) {
                        const item = JSON.parse(line);
                        const m = item.manifest || item;
                        feedbackStore.setBanner("packs", {
                          tone: "info",
                          message: en
                            ? `Found ${m.id} · v${m.version} (${m.kind}, ${m.entries} entries, not imported yet).`
                            : `检测到远程词库：${m.id} · v${m.version}（${m.kind}，基础版 ${m.baseVersion || "无"}，共 ${m.entries} 条，尚未导入）。`,
                        });
                        break;
                      }
                    } finally {
                      ac.abort();
                    }
                  });
                },
              )
            }
          >
            {en ? "Preview remote manifest" : "检查远程版本"}
          </Button>
        </div>

        <DataList
          items={cacheStatus?.packs || []}
          getKey={(p) => p.id}
          emptyMessage={
            en
              ? "No dictionary packs installed yet."
              : "暂无已安装词库。导入后即可离线秒级命中译文。"
          }
          lang={lang}
          renderItem={(p) => {
            const rowBusy = store.isBusy(`pack:${p.id}`);
            return (
              <>
                <div class="list-row-main">
                  <strong>
                    {p.id} · v{p.active}
                  </strong>
                  <p class="hint">
                    {[
                      p.enabled
                        ? en
                          ? "Enabled"
                          : "已启用"
                        : en
                          ? "Disabled"
                          : "已停用",
                      `${p.source_lang} → ${p.target_lang}`,
                      p.domain,
                      p.previous
                        ? en
                          ? `Previous: v${p.previous}`
                          : `上一版 v${p.previous}`
                        : en
                          ? "No previous version"
                          : "无旧版可回滚",
                      p.staging
                        ? en
                          ? `Staging: v${p.staging}`
                          : `未完成暂存 v${p.staging}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div class="actions">
                  <Button
                    busy={rowBusy}
                    onClick={() => void handlePackRowAction(p, "toggle")}
                  >
                    {p.enabled
                      ? en
                        ? "Disable"
                        : "停用"
                      : en
                        ? "Enable"
                        : "启用"}
                  </Button>
                  <Button
                    disabled={!p.previous || Boolean(p.staging) || rowBusy}
                    onClick={() => void handlePackRowAction(p, "rollback")}
                  >
                    {en ? "Rollback" : "回滚上一版"}
                  </Button>
                  {p.staging ? (
                    <Button
                      variant="danger"
                      disabled={rowBusy}
                      onClick={() => void handlePackRowAction(p, "abortPack")}
                    >
                      {en ? `Abort v${p.staging}` : `中止暂存 v${p.staging}`}
                    </Button>
                  ) : null}
                  <Button
                    variant="danger"
                    disabled={rowBusy}
                    onClick={() => void handlePackRowAction(p, "deletePack")}
                  >
                    {en ? "Delete" : "删除词库"}
                  </Button>
                </div>
              </>
            );
          }}
        />
      </fieldset>

      <fieldset>
        <legend>
          {en ? "User Revisions & History" : "用户人工修订与版本历史"}
        </legend>
        <FeedbackBanner scope="revisions" lang={lang} />

        <div class="grid">
          <TextInput
            label={en ? "Source language" : "源语言（如 en / auto）"}
            value={revSourceLang}
            onValueInput={(v) => {
              invalidateHistoryIfChanged();
              setRevSourceLang(v);
            }}
          />
          <TextInput
            label={en ? "Target language" : "目标语言（如 zh-CN / en）"}
            value={revTargetLang}
            onValueInput={(v) => {
              invalidateHistoryIfChanged();
              setRevTargetLang(v);
            }}
          />
          <TextInput
            label={
              en ? "Site domain (* = global)" : "适用域名（* 代表全局生效）"
            }
            value={revDomain}
            onValueInput={(v) => {
              invalidateHistoryIfChanged();
              setRevDomain(v);
            }}
          />
        </div>

        <Textarea
          label={en ? "Original text" : "原文段落"}
          rows={2}
          value={revSource}
          onValueInput={(v) => {
            invalidateHistoryIfChanged();
            setRevSource(v);
          }}
        />
        <Textarea
          label={en ? "Preferred translation" : "指定译文"}
          rows={2}
          value={revTranslation}
          onValueInput={(v) => setRevTranslation(v)}
        />

        <div class="actions">
          <Button
            variant="primary"
            busy={store.isBusy("revisions:save")}
            onClick={() =>
              runTracked(
                { key: "revisions:save", scope: "revisions", lang },
                async () => {
                  const snap = currentRevisionInput();
                  await runTracedUiOp("revision-save", async (t) => {
                    await scopedRpc(t).db("revision", [
                      { ...snap, translation: revTranslation },
                    ]);
                    await onRefreshCache();
                  });
                  toast(
                    en
                      ? "Revision saved and prioritized."
                      : "人工修订已保存，后续翻译将最高优先级采用。",
                    "success",
                  );
                },
              )
            }
          >
            {en ? "Save revision" : "保存修订"}
          </Button>
          <Button
            busy={store.isBusy("revisions:history")}
            onClick={() =>
              runTracked(
                { key: "revisions:history", scope: "revisions", lang },
                async () => {
                  const snap = currentRevisionInput();
                  const rows = await runTracedUiOp("revision-history", (t) =>
                    scopedRpc(t).db<
                      { revision: number; time: number; trace_id: string }[]
                    >("revisionHistory", [snap]),
                  );
                  setHistorySnapshotInput(snap);
                  setHistoryRows(rows);
                },
              )
            }
          >
            {en ? "View history" : "查看该段历史"}
          </Button>
          <Button
            variant="danger"
            busy={store.isBusy("revisions:clear")}
            onClick={async () => {
              const ok = await confirmAction({
                message: en
                  ? "Clear ALL user revisions and their version history? This cannot be undone."
                  : "确定清除全部用户修订及其历史版本吗？此操作无法撤销。",
                danger: true,
                lang,
              });
              if (!ok) return;
              await runTracked(
                { key: "revisions:clear", scope: "revisions", lang },
                async () => {
                  await runTracedUiOp("revision-clear", async (t) => {
                    const rpc = scopedRpc(t);
                    let more = true;
                    while (more) {
                      const r = await rpc.db<{ more: boolean }>(
                        "clearRevisions",
                      );
                      more = Boolean(r.more);
                    }
                    await onRefreshCache();
                  });
                  // Q-10: Clear rendered history list AND emit clear confirmation banner!
                  setHistoryRows(null);
                  setHistorySnapshotInput(null);
                  feedbackStore.setBanner("revisions", {
                    tone: "success",
                    message: en
                      ? "All user revisions and history cleared."
                      : "已清除全部用户修订及历史记录。",
                  });
                },
              );
            }}
          >
            {en ? "Clear all revisions" : "清除全部修订历史"}
          </Button>
        </div>

        {historyRows !== null ? (
          <DataList
            items={historyRows}
            getKey={(r) => r.revision}
            emptyMessage={
              en
                ? "No revision history recorded for this source segment."
                : "这段原文目前还没有修订历史。"
            }
            lang={lang}
            renderItem={(row) => (
              <>
                <div class="list-row-main">
                  <strong>v{row.revision}</strong>
                  <span class="hint">
                    {new Date(row.time).toLocaleString()}
                  </span>
                </div>
                <Button
                  busy={store.isBusy(`rev-restore:${row.revision}`)}
                  onClick={() =>
                    runTracked(
                      {
                        key: `rev-restore:${row.revision}`,
                        scope: "revisions",
                        lang,
                      },
                      async () => {
                        if (!historySnapshotInput) return;
                        const restoredEntry = await runTracedUiOp(
                          "revision-restore",
                          async (t) => {
                            const rpc = scopedRpc(t);
                            // Q-18: Always restore using historySnapshotInput captured when history was listed!
                            const entry = await rpc.db<{
                              translation: string;
                            }>("readRevision", [
                              historySnapshotInput,
                              row.revision,
                            ]);
                            await rpc.db("revision", [entry]);
                            await onRefreshCache();
                            return entry;
                          },
                        );
                        setRevTranslation(restoredEntry.translation);
                        toast(
                          en
                            ? `Restored v${row.revision} as latest revision.`
                            : `已将 v${row.revision} 恢复为最新生效修订。`,
                          "success",
                        );
                      },
                    )
                  }
                >
                  {en ? `Restore v${row.revision}` : `恢复 v${row.revision}`}
                </Button>
              </>
            )}
          />
        ) : null}
      </fieldset>

      <fieldset>
        <legend>
          {en
            ? "One-Way Sync to mistral-gui (Desktop Translation)"
            : "单向同步至 mistral-gui（供桌面端粘贴与截图翻译复用）"}
        </legend>
        <FeedbackBanner scope="sync" lang={lang} />
        <Switch
          checked={Boolean(config.syncDictionary)}
          onChange={async (checked) => {
            await runTracked(
              { key: "sync:toggle", scope: "sync", lang },
              async () => {
                await runTracedUiOp("sync-toggle", async (t) => {
                  const rpc = scopedRpc(t);
                  await rpc.send("SAVE", {
                    config: { syncDictionary: checked },
                    trace: t,
                  });
                  onSavedConfig(await rpc.send<SettingsView>("PRIVATE"));
                });
                toast(
                  checked
                    ? en
                      ? "Enabled sync with mistral-gui."
                      : "已开启向 mistral-gui 同步词库与修订。"
                    : en
                      ? "Disabled automatic sync."
                      : "已关闭自动同步。",
                  "success",
                );
              },
            );
          }}
          label={
            en
              ? "Allow syncing enabled dictionaries & user revisions to local mistral-gui"
              : "允许将已启用词库与用户修订同步到本地 mistral-gui（仅本机回环鉴权传输）"
          }
          hint={
            syncStatus?.syncedAt
              ? en
                ? `Last synced: ${new Date(syncStatus.syncedAt).toLocaleString()} (${syncStatus.revisions ?? 0} revisions, ${syncStatus.packEntries ?? 0} pack entries)`
                : `最近同步：${new Date(syncStatus.syncedAt).toLocaleString()}（修订 ${syncStatus.revisions ?? 0} 条 · 词库词条 ${syncStatus.packEntries ?? 0} 条）`
              : en
                ? "Requires Local URL & Local Token configured in Service settings."
                : "使用「翻译服务」中配置的本地管理器地址与 Token 进行鉴权。"
          }
        />
        <div class="actions">
          <Button
            busy={store.isBusy("sync:push")}
            onClick={() =>
              runTracked(
                { key: "sync:push", scope: "sync", lang },
                async () => {
                  const res = await runTracedUiOp("sync-now", async (t) => {
                    await grantOriginsOnce([config.localUrl], t);
                    const rpc = scopedRpc(t);
                    const out = await rpc.send<{
                      revisions: number;
                      packEntries: number;
                    }>("SYNC_NOW");
                    onSavedConfig(await rpc.send<SettingsView>("PRIVATE"));
                    return out;
                  });
                  feedbackStore.setBanner("sync", {
                    tone: "success",
                    message: en
                      ? `Synced ${res.revisions} revisions and ${res.packEntries} dictionary entries to mistral-gui.`
                      : `已同步 ${res.revisions} 条用户修订与 ${res.packEntries} 条词库词条至 mistral-gui。`,
                  });
                },
              )
            }
          >
            {en ? "Sync now" : "立即同步到 mistral-gui"}
          </Button>
          <Button
            variant="danger"
            busy={store.isBusy("sync:clear")}
            onClick={async () => {
              const ok = await confirmAction({
                message: en
                  ? "Clear synced dictionary & revision entries stored inside mistral-gui? Browser data stays intact."
                  : "确定清空 mistral-gui 中已接收的同步词库与修订吗？浏览器内的词库和修订不受影响。",
                danger: true,
                lang,
              });
              if (!ok) return;
              await runTracked(
                { key: "sync:clear", scope: "sync", lang },
                async () => {
                  await runTracedUiOp("sync-clear", async (t) => {
                    await grantOriginsOnce([config.localUrl], t);
                    const rpc = scopedRpc(t);
                    await rpc.send("SYNC_CLEAR");
                    onSavedConfig(await rpc.send<SettingsView>("PRIVATE"));
                  });
                  feedbackStore.setBanner("sync", {
                    tone: "success",
                    message: en
                      ? "Cleared synced dictionary copy in mistral-gui."
                      : "已清空 mistral-gui 中的同步词库副本。",
                  });
                },
              );
            }}
          >
            {en ? "Clear synced copy in manager" : "清空管理器中的同步副本"}
          </Button>
        </div>
      </fieldset>
    </section>
  );
}
