import { useEffect, useState } from "preact/hooks";
import {
  Badge,
  Button,
  DataList,
  Disclosure,
  FeedbackBanner,
  TextInput,
  VerdictHero,
  confirmAction,
  formatBytes,
  formatDurationMs,
  runTracked,
  toast,
  useFeedbackStore,
  type UiLang,
} from "../../design-system";
import type { TraceEvent } from "../types";
import { runTracedUiOp, scopedRpc } from "./rpc";
import type { TracePage } from "./types";

const EVENT_LABELS_ZH: Record<string, string> = {
  "operation.start": "操作开始",
  "operation.end": "操作完成",
  "ui.start": "界面操作开始",
  "ui.end": "界面操作结束",
  "ui.cancel": "用户取消操作",
  "cache.start": "缓存与词库查询开始",
  "cache.end": "缓存与词库查询完成",
  "cache.model": "模型缓存查询",
  "cache.legacy": "旧版缓存查询",
  "cache.heal": "异常缓存自愈清理",
  "cache.compress": "缓存块压缩",
  "cache.persist": "缓存批量写回",
  "cache.skip": "超限单条跳过",
  "queue.start": "进入请求调度池",
  "queue.acquire": "获得并发槽位",
  "queue.end": "释放并发槽位",
  "http.attempt.start": "发起服务请求",
  "http.attempt.end": "收到服务响应",
  "batch.fallback": "批次自动降级拆分",
  "provider.fallback": "本地回退至云端",
  "local.status.start": "查询本地管理器状态",
  "local.status.end": "本地管理器状态返回",
  "local.catalog.start": "读取本地部署目录",
  "local.catalog.end": "本地部署目录返回",
  "render.end": "网页段落渲染完成",
  "database.commit": "数据库事务提交",
  "worker.start": "存储工作线程任务开始",
  "worker.end": "存储工作线程任务结束",
  "permission.start": "请求域名访问授权",
  "permission.end": "域名授权结果",
  "pack.http.start": "下载远程词库开始",
  "pack.http.end": "下载远程词库响应",
  "pack.http.failed": "下载远程词库失败",
};

const OUTCOME_LABELS_ZH: Record<string, string> = {
  started: "进行中",
  success: "成功",
  failed: "失败",
  cancelled: "已取消",
  fallback: "已降级回退",
  paused: "已暂停",
};

function localizeEvent(ev: string, en: boolean): string {
  if (en) return ev;
  return EVENT_LABELS_ZH[ev] || ev;
}

function localizeOutcome(outcome: string | undefined, en: boolean): string {
  if (!outcome) return en ? "recorded" : "已记录";
  if (en) return outcome;
  return OUTCOME_LABELS_ZH[outcome] || outcome;
}

function outcomeTone(
  outcome?: string,
): "neutral" | "success" | "error" | "info" {
  if (outcome === "failed") return "error";
  if (outcome === "success") return "success";
  if (outcome === "fallback" || outcome === "paused") return "info";
  return "neutral";
}

const PAGE_SIZE = 200;

export function DiagnosticSection({ lang }: { lang: UiLang }) {
  const store = useFeedbackStore();
  const en = lang === "en";

  const [traceIdFilter, setTraceIdFilter] = useState("");
  const [batchIdFilter, setBatchIdFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [pageData, setPageData] = useState<TracePage | null>(null);

  // Q-02 & Q-29: Fetch targetOffset FIRST, and only commit setOffset(targetOffset) once TRACE_READ succeeds!
  const loadPage = async (targetOffset: number) => {
    const data = await runTracedUiOp("trace-read", (t) =>
      scopedRpc(t).send<TracePage>("TRACE_READ", {
        traceId: traceIdFilter.trim(),
        batchId: batchIdFilter.trim(),
        limit: PAGE_SIZE,
        offset: targetOffset,
      }),
    );
    setPageData(data);
    setOffset(targetOffset);
    return data;
  };

  useEffect(() => {
    void runTracked({ key: "diag:load", scope: "diagnostic", lang }, () =>
      loadPage(0),
    );
  }, []);

  const events: TraceEvent[] = pageData?.events || [];
  const hasMore = pageData?.hasMore ?? events.length >= PAGE_SIZE;
  const pageNumber = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <section class="page panel">
      <VerdictHero
        eyebrow={en ? "REDACTED DIAGNOSTICS" : "脱敏诊断与追踪"}
        title={
          en
            ? `Page ${pageNumber} · ${events.length} event(s) shown (newest first)`
            : `第 ${pageNumber} 页（最新优先）· 当前显示 ${events.length} 条记录`
        }
        description={
          en
            ? "Keys, tokens, source text, translations, and usage counts are never written to diagnostics."
            : "密钥、Token、原文、译文与用量统计均不会写入诊断记录；W3C traceparent 可与 mistral-gui 日志跨进程关联。"
        }
        badge={
          <Badge tone="neutral">
            {hasMore
              ? en
                ? "More pages available"
                : "可继续向后翻页"
              : en
                ? "End of history"
                : "已到最早一页"}
          </Badge>
        }
        metrics={[
          {
            label: en ? "Buffered in RAM" : "内存待落盘",
            value:
              pageData?.stats.pending == null
                ? "0"
                : en
                  ? `${pageData.stats.pending}`
                  : `${pageData.stats.pending} 条`,
          },
          {
            label: en ? "Flushes / Volume" : "诊断刷写 / 累计体积",
            value: pageData
              ? `${pageData.stats.flushes} / ${formatBytes(pageData.stats.diagnosticSubmittedBytes ?? 0, lang)}`
              : "—",
          },
          {
            label: en ? "Dropped" : "超限丢弃",
            value: String(pageData?.stats.dropped ?? 0),
          },
        ]}
      />

      <FeedbackBanner scope="diagnostic" lang={lang} />

      <fieldset>
        <legend>{en ? "Filter & Export" : "筛选与导出"}</legend>
        <div class="grid">
          <TextInput
            label={en ? "Trace ID (W3C 32-hex)" : "追踪编号（Trace ID）"}
            placeholder="00112233445566778899aabbccddeeff"
            value={traceIdFilter}
            onValueInput={(v) => setTraceIdFilter(v)}
          />
          <TextInput
            label={en ? "Batch ID" : "批次编号（Batch ID）"}
            placeholder={
              en ? "Optional batch identifier" : "可选填写单次批次标识"
            }
            value={batchIdFilter}
            onValueInput={(v) => setBatchIdFilter(v)}
          />
        </div>

        <div class="actions">
          <Button
            variant="primary"
            busy={store.isBusy("diag:search")}
            onClick={() =>
              runTracked(
                { key: "diag:search", scope: "diagnostic", lang },
                () => loadPage(0),
              )
            }
          >
            {en ? "Query records" : "查询记录"}
          </Button>
          <Button
            disabled={offset === 0 || store.isBusy("diag:page")}
            onClick={() =>
              runTracked({ key: "diag:page", scope: "diagnostic", lang }, () =>
                loadPage(Math.max(0, offset - PAGE_SIZE)),
              )
            }
          >
            {en ? "Newer page" : "较新一页"}
          </Button>
          <Button
            disabled={!hasMore || store.isBusy("diag:page")}
            onClick={() =>
              runTracked(
                { key: "diag:page", scope: "diagnostic", lang },
                async () => {
                  const res = await loadPage(offset + PAGE_SIZE);
                  if (!res.hasMore) {
                    toast(
                      en
                        ? "Reached the oldest diagnostic records."
                        : "已到达最早一页诊断记录。",
                      "info",
                    );
                  }
                },
              )
            }
          >
            {en ? "Older page" : "较旧一页"}
          </Button>
          <Button
            busy={store.isBusy("diag:export")}
            onClick={() =>
              runTracked(
                { key: "diag:export", scope: "diagnostic", lang },
                async () => {
                  const all = await runTracedUiOp("trace-export", (t) =>
                    scopedRpc(t).send<TracePage>("TRACE_READ", {
                      traceId: traceIdFilter.trim(),
                      batchId: batchIdFilter.trim(),
                    }),
                  );
                  const blob = new Blob(
                    [
                      JSON.stringify(
                        {
                          format: "qingyi-trace-v1",
                          exportedAt: new Date().toISOString(),
                          events: all.events,
                          stats: all.stats,
                        },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json" },
                  );
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `qingyi-diagnostics-${Date.now()}.json`;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 10000);
                  toast(
                    en
                      ? `Exported ${all.events.length} redacted diagnostic record(s).`
                      : `已导出 ${all.events.length} 条脱敏诊断记录。`,
                    "success",
                  );
                },
              )
            }
          >
            {en ? "Export JSON" : "导出脱敏 JSON"}
          </Button>
          <Button
            variant="danger"
            busy={store.isBusy("diag:clear")}
            onClick={async () => {
              // Q-24: Confirm before clearing diagnostic logs!
              const ok = await confirmAction({
                message: en
                  ? "Clear all stored diagnostic trace records?"
                  : "确定清空全部已记录的诊断追踪日志吗？",
                danger: true,
                lang,
              });
              if (!ok) return;
              await runTracked(
                { key: "diag:clear", scope: "diagnostic", lang },
                async () => {
                  await runTracedUiOp("trace-clear", (t) =>
                    scopedRpc(t).send("TRACE_CLEAR"),
                  );
                  await loadPage(0);
                  toast(
                    en ? "Diagnostics cleared." : "已清空全部诊断记录。",
                    "success",
                  );
                },
              );
            }}
          >
            {en ? "Clear diagnostics" : "清除诊断"}
          </Button>
        </div>
      </fieldset>

      <DataList
        items={events}
        getKey={(e, idx) => `${e.time}-${e.spanId || idx}-${idx}`}
        emptyMessage={
          en ? "No matching diagnostic records." : "暂无匹配的诊断记录。"
        }
        lang={lang}
        renderItem={(ev) => (
          <div style={{ width: "100%" }}>
            <div class="split-head">
              <div>
                <strong>{localizeEvent(ev.event, en)}</strong>{" "}
                <code class="hint">{ev.event}</code>
              </div>
              <div class="actions" style={{ margin: 0 }}>
                {ev.durationMs != null ? (
                  <span class="hint">
                    {formatDurationMs(ev.durationMs, lang)}
                  </span>
                ) : null}
                <Badge tone={outcomeTone(ev.outcome)}>
                  {localizeOutcome(ev.outcome, en)}
                </Badge>
              </div>
            </div>
            <p class="hint" style={{ marginTop: "5px" }}>
              {new Date(ev.time).toLocaleString()}
              {ev.traceId ? ` · trace: ${ev.traceId.slice(0, 12)}…` : ""}
              {(ev as any).reason ? ` · ${(ev as any).reason}` : ""}
              {(ev as any).status ? ` · HTTP ${(ev as any).status}` : ""}
            </p>
            <Disclosure summary={en ? "Event fields" : "查看关联技术字段"}>
              <pre>{JSON.stringify(ev, null, 2)}</pre>
            </Disclosure>
          </div>
        )}
      />
    </section>
  );
}
