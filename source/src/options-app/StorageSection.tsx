import { useEffect, useRef, useState } from "preact/hooks";
import {
  Badge,
  Button,
  FeedbackBanner,
  StateBlock,
  TextInput,
  VerdictHero,
  confirmAction,
  feedbackStore,
  formatBytes,
  formatUnknown,
  runTracked,
  toast,
  useFeedbackStore,
  type UiLang,
} from "../../design-system";
import { newTrace } from "../trace";
import { MiB } from "../types";
import { recordTrace, runTracedUiOp, scopedRpc } from "./rpc";
import type { CacheStatus, SettingsView } from "./types";

function formatNullableCount(
  val: number | null | undefined,
  en: boolean,
): string {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return formatUnknown(null, en ? "en" : "zh-CN");
  }
  return en ? `${val.toLocaleString()} entries` : `${val.toLocaleString()} 条`;
}

export function StorageSection({
  config,
  budgetDraftGiB,
  setBudgetDraftGiB,
  cacheStatus,
  cacheError,
  onRefreshCache,
  onSavedConfig,
  lang,
}: {
  config: SettingsView;
  budgetDraftGiB: string;
  setBudgetDraftGiB: (v: string) => void;
  cacheStatus: CacheStatus | null;
  cacheError: string | null;
  onRefreshCache: () => Promise<void>;
  onSavedConfig: (next: SettingsView) => void;
  lang: UiLang;
}) {
  const store = useFeedbackStore();
  const en = lang === "en";
  const [budgetError, setBudgetError] = useState<string>("");
  const [maintenanceRunning, setMaintenanceRunning] = useState(false);
  const maintenanceStopRef = useRef(false);
  const maintenanceTraceRef = useRef(newTrace());

  useEffect(() => {
    if (!cacheStatus && !cacheError) {
      void onRefreshCache();
    }
  }, []);

  const handleSaveBudget = () =>
    runTracked({ key: "storage:budget", scope: "storage", lang }, async () => {
      const raw = budgetDraftGiB.trim();
      const num = Number(raw);
      if (raw === "" || !Number.isFinite(num) || num < 0.0625 || num > 64) {
        setBudgetError(
          en
            ? "Enter a budget between 0.0625 GiB (64 MiB) and 64 GiB."
            : "请填写 0.0625 GiB（64 MiB）至 64 GiB 之间的缓存预算。",
        );
        throw new Error("INVALID_BUDGET");
      }
      setBudgetError("");
      await runTracedUiOp("budget-save", async (t) => {
        const rpc = scopedRpc(t);
        await rpc.send("SAVE", {
          config: { budgetBytes: Math.round(num * 1024 * MiB) },
          trace: t,
        });
        onSavedConfig(await rpc.send<SettingsView>("PRIVATE"));
        await onRefreshCache();
      });
      toast(en ? "Cache budget saved." : "缓存总预算已保存。", "success");
    });

  // Q-12: Explicit success feedback + clear stale error banner on refresh & flush!
  const handleRefresh = () =>
    runTracked({ key: "storage:refresh", scope: "storage", lang }, async () => {
      feedbackStore.clearBanner("storage");
      await onRefreshCache();
      toast(
        en ? "Cache statistics refreshed." : "已刷新本地缓存统计。",
        "success",
      );
    });

  const handleFlush = () =>
    runTracked({ key: "storage:flush", scope: "storage", lang }, async () => {
      feedbackStore.setBanner("storage", {
        tone: "info",
        message: en
          ? "Committing buffered translations to SQLite…"
          : "正在提交待写缓存到 SQLite…",
        autoDismissMs: 0,
      });
      await runTracedUiOp("cache-flush", async (t) => {
        await scopedRpc(t).db("flush");
        await onRefreshCache();
      });
      feedbackStore.setBanner("storage", {
        tone: "success",
        message: en
          ? "All pending translations committed to disk."
          : "待写缓存已全部提交落盘。",
      });
    });

  const handlePurgeInvalid = () =>
    runTracked(
      { key: "storage:purge-invalid", scope: "storage", lang },
      async () => {
        feedbackStore.setBanner("storage", {
          tone: "info",
          message: en
            ? "Scanning model cache for corrupt placeholder entries…"
            : "正在扫描并清理异常占位符缓存条目…",
          autoDismissMs: 0,
        });
        const res = await runTracedUiOp("purge-invalid", async (t) => {
          const out = await scopedRpc(t).db<{
            scanned: number;
            purged: number;
          }>("purgeInvalidModels");
          await onRefreshCache();
          return out;
        });
        feedbackStore.setBanner("storage", {
          tone: "success",
          message: en
            ? `Scanned ${res.scanned} entries and removed ${res.purged} invalid entry(ies).`
            : `扫描完成（共检查 ${res.scanned} 条），已移除 ${res.purged} 条异常占位符缓存。`,
        });
      },
    );

  // Q-11: Immediate "in progress" banner BEFORE first batch + clear terminal completion message!
  const handleClearModels = async () => {
    const ok = await confirmAction({
      message: en
        ? "Clear all cached cloud & local model translations? Dictionary packs and user revisions will be preserved."
        : "确定清理全部云端与本地模型缓存吗？已导入词库与用户修订将完整保留。",
      danger: true,
      lang,
    });
    if (!ok) return;

    await runTracked(
      { key: "storage:clear-models", scope: "storage", lang },
      async () => {
        let totalCleared = 0;
        feedbackStore.setBanner("storage", {
          tone: "info",
          message: en
            ? "Clearing model cache in bounded batches…"
            : "正在分批清理模型缓存索引…",
          autoDismissMs: 0,
        });
        await runTracedUiOp("clear-models", async (t) => {
          const rpc = scopedRpc(t);
          let more = true;
          while (more) {
            const r = await rpc.db<{ cleared: number; more: boolean }>(
              "clearModels",
            );
            totalCleared += r.cleared || 0;
            more = Boolean(r.more);
            if (more) {
              feedbackStore.setBanner("storage", {
                tone: "info",
                message: en
                  ? `Clearing model cache… (${totalCleared} removed)`
                  : `正在分批清理模型缓存…（已清理 ${totalCleared} 条）`,
                autoDismissMs: 0,
              });
            }
          }
          await onRefreshCache();
        });
        feedbackStore.setBanner("storage", {
          tone: "success",
          message: en
            ? `Model cache cleared (${totalCleared} entries removed).`
            : `模型缓存清理完成（共移除 ${totalCleared} 条）。`,
        });
      },
    );
  };

  // Q-11 & Q-30: Track maintenance running state accurately and emit clear terminal status when stopped or finished
  const handleCollect = () =>
    runTracked({ key: "storage:collect", scope: "storage", lang }, async () => {
      const t = newTrace();
      maintenanceTraceRef.current = t;
      maintenanceStopRef.current = false;
      setMaintenanceRunning(true);
      let totalBytes = 0;
      let lastBudgetRem = 8 * MiB;
      feedbackStore.setBanner("storage", {
        tone: "info",
        message: en
          ? "Running bounded block maintenance…"
          : "正在执行空闲块与过期版本回收维护…",
        autoDismissMs: 0,
      });
      try {
        await runTracedUiOp(
          "maintenance-collect",
          async () => {
            const rpc = scopedRpc(t);
            while (!maintenanceStopRef.current) {
              const r = await rpc.db<{
                bytes: number;
                budgetRemaining: number;
                more: boolean;
              }>("collect", [], t);
              totalBytes += r.bytes || 0;
              lastBudgetRem = r.budgetRemaining ?? 0;
              if ((!r.bytes && !r.more) || !r.budgetRemaining) break;
              feedbackStore.setBanner("storage", {
                tone: "info",
                message: en
                  ? `Maintenance reclaimed ${formatBytes(totalBytes, lang)} (hourly budget left: ${formatBytes(lastBudgetRem, lang)})…`
                  : `正在分批维护：本轮已整理 ${formatBytes(totalBytes, lang)}（本小时维护预算剩余 ${formatBytes(lastBudgetRem, lang)}）…`,
                autoDismissMs: 0,
              });
              await new Promise((res) => setTimeout(res, 80));
            }
            await onRefreshCache();
          },
          t,
        );
        if (maintenanceStopRef.current) {
          feedbackStore.setBanner("storage", {
            tone: "info",
            message: en
              ? `Maintenance stopped cleanly (${formatBytes(totalBytes, lang)} processed).`
              : `维护已按请求停止（本轮共处理 ${formatBytes(totalBytes, lang)}）。`,
          });
        } else {
          feedbackStore.setBanner("storage", {
            tone: "success",
            message: en
              ? `Maintenance finished (${formatBytes(totalBytes, lang)} processed; hourly budget remaining: ${formatBytes(lastBudgetRem, lang)}).`
              : `本轮空闲块维护已完成（共处理 ${formatBytes(totalBytes, lang)}，本小时预算剩余 ${formatBytes(lastBudgetRem, lang)}）。`,
          });
        }
      } finally {
        setMaintenanceRunning(false);
      }
    });

  const handleStopMaintenance = () => {
    if (!maintenanceRunning) return;
    maintenanceStopRef.current = true;
    const t = maintenanceTraceRef.current;
    void recordTrace(t, "ui.cancel", {
      outcome: "cancelled",
      resourceId: "maintenance",
    });
    feedbackStore.setBanner("storage", {
      tone: "info",
      message: en
        ? "Stopping maintenance after current batch…"
        : "正在等待当前小批次完成后停止维护…",
      autoDismissMs: 0,
    });
    void scopedRpc(t)
      .db("maintenanceStop", [], t)
      .catch((err) => feedbackStore.reportError("storage", err, lang));
  };

  return (
    <section class="page panel">
      <VerdictHero
        eyebrow={en ? "SQLITE / OPFS STORAGE" : "本地缓存状态"}
        title={
          cacheError
            ? en
              ? "Cache initialization encountered an error"
              : "本地缓存读取未就绪（已有磁盘数据保留）"
            : cacheStatus?.writeError
              ? en
                ? "Automatic writeback paused · Action required"
                : "自动写回已暂停 · 请释放空间后点击「提交待写缓存」重试"
              : en
                ? "SQLite / OPFS connected · Zero-write on cache hit"
                : "SQLite / OPFS 运行正常 · 缓存命中不产生磁盘写入"
        }
        tone={cacheError || cacheStatus?.writeError ? "error" : "success"}
        badge={
          <Badge
            tone={cacheError || cacheStatus?.writeError ? "error" : "success"}
          >
            {cacheError
              ? en
                ? "Unavailable"
                : "未就绪"
              : cacheStatus?.writeError
                ? en
                  ? "Paused"
                  : "需要处理"
                : en
                  ? "Healthy"
                  : "就绪"}
          </Badge>
        }
        metrics={[
          {
            label: en ? "Database Size" : "数据库占用",
            value: cacheStatus
              ? formatBytes(cacheStatus.dbBytes, lang)
              : formatUnknown(null, lang),
          },
          {
            label: en ? "Pending Buffer" : "内存待写入",
            value:
              cacheStatus?.pending == null
                ? formatUnknown(null, lang)
                : en
                  ? `${cacheStatus.pending} (${formatBytes(cacheStatus.pendingBytes, lang)})`
                  : `${cacheStatus.pending} 条（${formatBytes(cacheStatus.pendingBytes, lang)}）`,
          },
          {
            label: en ? "Total Budget" : "缓存总预算",
            value: formatBytes(config.budgetBytes, lang),
          },
        ]}
      />

      <FeedbackBanner scope="storage" lang={lang} />

      {cacheError ? (
        <StateBlock
          kind="failed"
          title={en ? "Storage worker unavailable" : "无法连接本地缓存数据库"}
          message={
            en
              ? "Existing data on disk is untouched. Click Retry to reconnect."
              : "已有缓存与词库数据保持安全。请点击重试重新连接存储工作线程。"
          }
          detail={cacheError}
          onRetry={handleRefresh}
          lang={lang}
        />
      ) : null}

      {cacheStatus?.writeError ? (
        <StateBlock
          kind="failed"
          title={en ? "Writeback paused" : "自动写回已暂停"}
          message={
            en
              ? `Reason: ${cacheStatus.writeError}. Free up space or adjust budget, then click "Commit Pending Cache" below.`
              : `原因：${cacheStatus.writeError}。腾出空间或调高预算后，点击下方「提交待写缓存」按钮即可恢复。`
          }
          lang={lang}
        />
      ) : null}

      <fieldset>
        <legend>{en ? "Cache Budget" : "空间预算设置"}</legend>
        <div class="grid">
          <TextInput
            label={en ? "Total cache budget (GiB)" : "本地缓存总预算（GiB）"}
            type="number"
            min={0.25}
            max={64}
            step={0.25}
            value={budgetDraftGiB}
            error={budgetError}
            hint={
              en
                ? "Minimum 0.0625 GiB (64 MiB), step 0.25 GiB. When full, oldest cloud cache blocks evict automatically (FIFO) while dictionaries and user revisions stay untouched."
                : "范围 0.0625–64 GiB（步进 0.25 GiB）。预算满时按写入顺序（FIFO）自动淘汰旧云端缓存，词库与用户修订永久保留；本地模型结果独立在 256 MiB 上限内按 FIFO 轮转，以遵守命中零写入约定。"
            }
            onValueInput={(v) => {
              setBudgetError("");
              setBudgetDraftGiB(v);
            }}
          />
        </div>
        <div class="actions">
          <Button
            variant="primary"
            busy={store.isBusy("storage:budget")}
            onClick={handleSaveBudget}
          >
            {en ? "Save budget" : "保存预算"}
          </Button>
        </div>
      </fieldset>

      {cacheStatus ? (
        <fieldset>
          <legend>
            {en ? "Detailed Storage Breakdown" : "存储明细与维护"}
          </legend>
          <div class="rows">
            <div class="list-row">
              <div class="list-row-main">
                <strong>{en ? "Cloud model entries" : "云端模型缓存"}</strong>
                <span class="hint">
                  {en
                    ? "Auto-evicts oldest blocks when budget reached"
                    : "预算满时自动淘汰最旧块"}
                </span>
              </div>
              <span>{formatNullableCount(cacheStatus.modelEntries, en)}</span>
            </div>
            <div class="list-row">
              <div class="list-row-main">
                <strong>
                  {en
                    ? "Local model entries (FIFO)"
                    : "本地模型缓存（FIFO 淘汰）"}
                </strong>
                <span class="hint">
                  {en
                    ? "Capped at 256 MiB, isolated by model & deployment revision"
                    : "独立上限 256 MiB，按模型与部署指纹隔离"}
                </span>
              </div>
              <span>
                {formatNullableCount(cacheStatus.localModelEntries, en)} ·{" "}
                {formatBytes(cacheStatus.localModelBytes, lang)}
              </span>
            </div>
            <div class="list-row">
              <div class="list-row-main">
                <strong>{en ? "User revisions" : "用户人工修订"}</strong>
              </div>
              <span>{formatNullableCount(cacheStatus.revisions, en)}</span>
            </div>
            <div class="list-row">
              <div class="list-row-main">
                <strong>
                  {en
                    ? "Compressed blocks / Raw payload"
                    : "压缩块体积 / 原始文本"}
                </strong>
              </div>
              <span>
                {cacheStatus.blockBytes == null
                  ? formatUnknown(null, lang)
                  : formatBytes(cacheStatus.blockBytes, lang)}{" "}
                /{" "}
                {cacheStatus.rawBytes == null
                  ? formatUnknown(null, lang)
                  : formatBytes(cacheStatus.rawBytes, lang)}
              </span>
            </div>
            <div class="list-row">
              <div class="list-row-main">
                <strong>
                  {en
                    ? "Reusable freelist / Hot memory"
                    : "可复用空闲页 / 内存热缓存"}
                </strong>
              </div>
              <span>
                {formatBytes(cacheStatus.freeBytes, lang)} /{" "}
                {formatBytes(cacheStatus.hotBytes, lang)}
              </span>
            </div>
            <div class="list-row">
              <div class="list-row-main">
                <strong>
                  {en
                    ? "Worker logical writes (session)"
                    : "本次 Worker 逻辑提交 / 维护提交"}
                </strong>
                <span class="hint">
                  {en
                    ? "Application bytes submitted, not physical SSD erase cycles"
                    : "应用层提交字节数，不等于固态硬盘物理擦写量"}
                </span>
              </div>
              <span>
                {formatBytes(cacheStatus.metrics.submittedBytes, lang)} /{" "}
                {formatBytes(cacheStatus.metrics.maintenanceBytes, lang)}
              </span>
            </div>
          </div>

          <div class="actions">
            <Button
              busy={store.isBusy("storage:refresh")}
              onClick={handleRefresh}
            >
              {en ? "Refresh stats" : "刷新统计"}
            </Button>
            <Button busy={store.isBusy("storage:flush")} onClick={handleFlush}>
              {en ? "Commit Pending Cache" : "提交待写缓存"}
            </Button>
            <Button
              busy={store.isBusy("storage:purge-invalid")}
              onClick={handlePurgeInvalid}
            >
              {en ? "Clean corrupt entries" : "清理异常占位符缓存"}
            </Button>
            <Button
              busy={store.isBusy("storage:collect")}
              disabled={maintenanceRunning}
              onClick={handleCollect}
            >
              {en ? "Run block maintenance" : "整理空闲块"}
            </Button>
            <Button
              disabled={!maintenanceRunning}
              onClick={handleStopMaintenance}
            >
              {en ? "Stop maintenance" : "停止维护"}
            </Button>
            <Button
              variant="danger"
              busy={store.isBusy("storage:clear-models")}
              onClick={() => void handleClearModels()}
            >
              {en ? "Clear model cache" : "清理模型缓存"}
            </Button>
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}
