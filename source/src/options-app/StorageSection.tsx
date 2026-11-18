import { useEffect, useRef, useState } from "preact/hooks";
import {
  Badge,
  Button,
  FeedbackBanner,
  IconRefresh,
  IconTrash,
  MetricGrid,
  SettingGroup,
  SettingRow,
  StateBlock,
  NumberStepper,
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
      <FeedbackBanner scope="storage" lang={lang} />

      <MetricGrid
        items={[
          {
            label: en ? "Database Size" : "数据库占用",
            value: cacheStatus
              ? formatBytes(cacheStatus.dbBytes, lang)
              : formatUnknown(null, lang),
          },
          {
            label: en ? "Pending Buffer" : "待落盘缓冲",
            value:
              cacheStatus?.pending == null
                ? formatUnknown(null, lang)
                : en
                  ? `${cacheStatus.pending} (${formatBytes(cacheStatus.pendingBytes, lang)})`
                  : `${cacheStatus.pending} 条（${formatBytes(cacheStatus.pendingBytes, lang)}）`,
          },
          {
            label: en ? "Total Budget" : "空间预算上限",
            value: formatBytes(config.budgetBytes, lang),
          },
          {
            label: en ? "Status" : "引擎状态",
            value: (
              <Badge
                tone={
                  cacheError || cacheStatus?.writeError ? "error" : "success"
                }
              >
                {cacheError
                  ? en
                    ? "Unavailable"
                    : "未就绪"
                  : cacheStatus?.writeError
                    ? en
                      ? "Paused"
                      : "写回暂停"
                    : en
                      ? "Healthy"
                      : "运行正常"}
              </Badge>
            ),
          },
        ]}
      />

      {cacheError ? (
        <StateBlock
          kind="failed"
          title={en ? "Storage worker unavailable" : "无法连接本地缓存数据库"}
          message={
            en
              ? "Existing data on disk is untouched. Click Retry to reconnect."
              : "已有缓存与词库数据保持安全，点击重试重新连接。"
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
              ? `Reason: ${cacheStatus.writeError}. Free up space or adjust budget, then click Commit Pending Cache.`
              : `原因：${cacheStatus.writeError}。腾出空间或调高预算后，点击下方「提交待写缓存」恢复。`
          }
          lang={lang}
        />
      ) : null}

      <SettingGroup title={en ? "Storage Budget" : "空间预算"}>
        <SettingRow
          title={en ? "Total cache budget (GiB)" : "本地缓存总预算（GiB）"}
          description={
            en
              ? "0.0625–64 GiB. Evicts oldest cloud blocks (FIFO) when full; dictionaries and revisions are never evicted."
              : "范围 0.0625–64 GiB。满额时自动按写入顺序淘汰旧云端缓存，词库与人工修订永久保留。"
          }
          error={budgetError}
        >
          <div style={{ width: "155px", maxWidth: "100%" }}>
            <NumberStepper
              en={en}
              name={en ? "Cache budget" : "缓存预算"}
              unit="GiB"
              min={0.0625}
              max={64}
              step={0.0625}
              value={budgetDraftGiB}
              onValueInput={(v) => {
                setBudgetError("");
                setBudgetDraftGiB(v);
              }}
            />
          </div>
          <Button
            variant="primary"
            busy={store.isBusy("storage:budget")}
            onClick={handleSaveBudget}
          >
            {en ? "Save" : "保存预算"}
          </Button>
        </SettingRow>
      </SettingGroup>

      {cacheStatus ? (
        <SettingGroup
          title={en ? "Storage Breakdown & Maintenance" : "缓存明细与维护"}
          actions={
            <>
              <Button
                size="sm"
                icon={<IconRefresh size={13} />}
                busy={store.isBusy("storage:refresh")}
                onClick={handleRefresh}
              >
                {en ? "Refresh" : "刷新"}
              </Button>
              <Button
                size="sm"
                busy={store.isBusy("storage:flush")}
                onClick={handleFlush}
              >
                {en ? "Commit Pending" : "提交待写缓存"}
              </Button>
              <Button
                size="sm"
                busy={store.isBusy("storage:purge-invalid")}
                onClick={handlePurgeInvalid}
              >
                {en ? "Clean Corrupt" : "清理坏占位符"}
              </Button>
              {maintenanceRunning ? (
                <Button size="sm" onClick={handleStopMaintenance}>
                  {en ? "Stop" : "停止维护"}
                </Button>
              ) : (
                <Button
                  size="sm"
                  busy={store.isBusy("storage:collect")}
                  onClick={handleCollect}
                >
                  {en ? "Compact" : "整理空闲块"}
                </Button>
              )}
              <Button
                size="sm"
                variant="danger"
                icon={<IconTrash size={13} />}
                busy={store.isBusy("storage:clear-models")}
                onClick={() => void handleClearModels()}
              >
                {en ? "Clear Cache" : "清空模型缓存"}
              </Button>
            </>
          }
        >
          <SettingRow
            title={en ? "Cloud model cache" : "云端模型缓存"}
            description={en ? "FIFO block eviction" : "满额自动淘汰最旧块"}
          >
            <span>{formatNullableCount(cacheStatus.modelEntries, en)}</span>
          </SettingRow>
          <SettingRow
            title={en ? "Local model cache" : "本地模型缓存"}
            description={
              en
                ? "256 MiB cap, isolated by model revision"
                : "独立 256 MiB 上限，按模型版本隔离"
            }
          >
            <span>
              {formatNullableCount(cacheStatus.localModelEntries, en)} ·{" "}
              {formatBytes(cacheStatus.localModelBytes, lang)}
            </span>
          </SettingRow>
          <SettingRow title={en ? "User revisions" : "人工修订条数"}>
            <span>{formatNullableCount(cacheStatus.revisions, en)}</span>
          </SettingRow>
          <SettingRow
            title={en ? "Compressed / Raw payload" : "压缩块体积 / 原始文本"}
          >
            <span>
              {cacheStatus.blockBytes == null
                ? formatUnknown(null, lang)
                : formatBytes(cacheStatus.blockBytes, lang)}{" "}
              /{" "}
              {cacheStatus.rawBytes == null
                ? formatUnknown(null, lang)
                : formatBytes(cacheStatus.rawBytes, lang)}
            </span>
          </SettingRow>
          <SettingRow
            title={
              en ? "Reusable freelist / Hot RAM" : "可复用空闲页 / 内存热缓存"
            }
          >
            <span>
              {formatBytes(cacheStatus.freeBytes, lang)} /{" "}
              {formatBytes(cacheStatus.hotBytes, lang)}
            </span>
          </SettingRow>
          <SettingRow
            title={
              en ? "Session logical writes" : "本次会话应用层写入 / 维护写入"
            }
          >
            <span>
              {formatBytes(cacheStatus.metrics.submittedBytes, lang)} /{" "}
              {formatBytes(cacheStatus.metrics.maintenanceBytes, lang)}
            </span>
          </SettingRow>
        </SettingGroup>
      ) : null}
    </section>
  );
}
