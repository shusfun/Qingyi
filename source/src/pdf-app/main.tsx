import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import * as pdfjsLib from "pdfjs-dist";
import "../../design-system/tokens.css";
import "../../design-system/components.css";
import "./pdf.css";
import {
  Badge,
  Button,
  ConfirmModal,
  FeedbackBanner,
  SelectField,
  ToastHost,
  VerdictHero,
  feedbackStore,
  runTracked,
  toast,
  useFeedbackStore,
  type UiLang,
} from "../../design-system";
import { childTrace, newTrace } from "../trace";
import { sendRpc, recordTrace } from "../options-app/rpc";
import { splitSegments } from "../segments";
import type { SettingsView } from "../options-app/types";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("assets/pdf.worker.min.mjs")
    : "./assets/pdf.worker.min.mjs";

interface PdfParagraph {
  id: string;
  page: number;
  source: string;
  translation?: string;
  channel?: string;
  error?: string;
}

interface PdfPageData {
  pageNumber: number;
  paragraphs: PdfParagraph[];
}

function mergePdfTextItems(items: any[]): string[] {
  const lines: { y: number; text: string }[] = [];
  for (const item of items) {
    if (!item || typeof item.str !== "string") continue;
    const str = item.str.trim();
    if (!str) continue;
    const y = Array.isArray(item.transform)
      ? Number(item.transform[5]) || 0
      : 0;
    const prev = lines[lines.length - 1];
    if (prev && Math.abs(prev.y - y) < 4) {
      prev.text += (/[a-zA-Z0-9]$/.test(prev.text) ? " " : "") + str;
    } else {
      lines.push({ y, text: str });
    }
  }
  const paragraphs: string[] = [];
  let current = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text.trim();
    if (!line) continue;
    if (!current) {
      current = line;
      continue;
    }
    const gap = Math.abs(lines[i - 1].y - lines[i].y);
    const endsSentence = /[.!?。！？:：]$/.test(current);
    if (gap > 18 || (endsSentence && current.length > 140)) {
      paragraphs.push(current);
      current = line;
    } else if (current.endsWith("-") && /^[a-z]/.test(line)) {
      current = current.slice(0, -1) + line;
    } else {
      current += (/[a-zA-Z0-9,;]$/.test(current) ? " " : "") + line;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs.filter((p) => p.length >= 2);
}

function PdfCanvasPreview({
  pdfDoc,
  pageNumber,
}: {
  pdfDoc: any;
  pageNumber: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled || !canvasRef.current) return;
        const viewport = page.getViewport({ scale: 1.15 });
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch {
        // ignore cancelled render
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageNumber]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height: "auto",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)",
        background: "var(--color-raised)",
      }}
    />
  );
}

function PdfApp() {
  const store = useFeedbackStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfDocRef = useRef<any>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [lang, setLang] = useState<UiLang>("zh-CN");
  const [viewMode, setViewMode] = useState<
    "bilingual" | "chinese" | "original"
  >("bilingual");
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [docTitle, setDocTitle] = useState("");
  const [pages, setPages] = useState<PdfPageData[]>([]);
  const [translating, setTranslating] = useState(false);
  const [progressText, setProgressText] = useState("");

  const en = lang === "en";

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await sendRpc<SettingsView>("PRIVATE");
        const resolvedLang: UiLang = cfg["ui.locale"] === "en" ? "en" : "zh-CN";
        setLang(resolvedLang);
        if (cfg["ui.theme"] && cfg["ui.theme"] !== "system") {
          document.documentElement.dataset.theme = cfg["ui.theme"];
        }
        if (cfg.mode === "chinese" || cfg.mode === "bilingual") {
          setViewMode(cfg.mode);
        }
        if (cfg.targetLang) setTargetLang(cfg.targetLang);

        const params = new URLSearchParams(location.search);
        const fileParam = params.get("file");
        if (fileParam && /^https?:/i.test(fileParam)) {
          await loadPdfFromSource(
            { url: fileParam },
            fileParam.split("/").pop() || "PDF",
          );
        } else if (fileParam && fileParam.startsWith("file:")) {
          feedbackStore.setBanner("pdf", {
            tone: "info",
            message:
              resolvedLang === "en"
                ? "Select the local PDF file below to read & translate offline (browsers restrict direct file:// fetch)."
                : "由于浏览器限制直接读取 file:// 链接，请点击下方「打开本地 PDF 文件」选择该文件即可离线阅读与翻译。",
            autoDismissMs: 0,
          });
        }
      } catch (err) {
        feedbackStore.reportError("pdf", err, lang);
      }
    })();
  }, []);

  const loadPdfFromSource = async (
    src: { data?: Uint8Array; url?: string },
    label: string,
  ) => {
    await runTracked({ key: "pdf:load", scope: "pdf", lang }, async () => {
      abortRef.current?.abort();
      const loadingTask = pdfjsLib.getDocument({
        ...src,
      });
      const doc = await loadingTask.promise;
      pdfDocRef.current = doc;
      setDocTitle(label);

      const loadedPages: PdfPageData[] = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const merged = mergePdfTextItems(content.items || []).flatMap((text) =>
          splitSegments(text, 3000),
        );
        loadedPages.push({
          pageNumber: p,
          paragraphs: merged.map((text, idx) => ({
            id: `p${p}-${idx}`,
            page: p,
            source: text,
          })),
        });
      }
      setPages(loadedPages);
      const totalParas = loadedPages.reduce(
        (acc, p) => acc + p.paragraphs.length,
        0,
      );
      feedbackStore.setBanner("pdf", {
        tone: "success",
        message: en
          ? `Loaded "${label}" (${doc.numPages} page(s), ${totalParas} extractable paragraph(s)).`
          : `已加载「${label}」（共 ${doc.numPages} 页，提取出 ${totalParas} 个可翻译段落）。`,
      });
    });
  };

  const handleFilePick = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await loadPdfFromSource({ data: bytes }, file.name);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const translateParagraphSubset = async (subset: PdfParagraph[]) => {
    if (!subset.length || translating) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setTranslating(true);
    const rootTrace = newTrace();
    void recordTrace(rootTrace, "pdf.translate.start", {
      outcome: "started",
      items: subset.length,
    });
    let failed = 0;
    try {
      let done = 0;
      const batchSize = 8;
      for (let i = 0; i < subset.length; i += batchSize) {
        if (ac.signal.aborted) break;
        const chunk = subset.slice(i, i + batchSize);
        setProgressText(
          en
            ? `Translating ${done}/${subset.length}…`
            : `正在翻译 ${done} / ${subset.length} 段…`,
        );
        const batchTrace = childTrace(rootTrace, {
          batchId: crypto.randomUUID(),
        });
        const res = await sendRpc<{
          translations: (string | null)[];
          channels?: string[];
          errors?: (string | undefined)[];
        }>(
          "TRANSLATE",
          {
            sources: chunk.map((c) => c.source),
            domain: "https://qingyi.pdf.local",
            sourceLang: "auto",
            targetLang,
            priority: 1,
            trace: batchTrace,
          },
          { signal: ac.signal, timeoutMs: 90_000 },
        );

        const updates = new Map<
          string,
          { translation?: string; channel?: string; error?: string }
        >();
        chunk.forEach((item, idx) => {
          const tr = res.translations[idx];
          if (!tr) failed++;
          updates.set(item.id, {
            translation: tr ?? undefined,
            channel: res.channels?.[idx],
            error: res.errors?.[idx],
          });
        });
        setPages((prev) =>
          prev.map((pg) => ({
            ...pg,
            paragraphs: pg.paragraphs.map((para) =>
              updates.has(para.id)
                ? { ...para, ...updates.get(para.id)! }
                : para,
            ),
          })),
        );
        done += chunk.length;
      }
      if (!ac.signal.aborted) {
        if (failed) {
          feedbackStore.setBanner("pdf", {
            tone: "warning",
            message: en
              ? `${failed} paragraphs failed. Retry untranslated paragraphs.`
              : `${failed} 个段落未能翻译，可重试待译段落。`,
          });
        } else
          toast(
            en
              ? `Finished translating ${subset.length} paragraph(s).`
              : `已完成 ${subset.length} 个段落的翻译。`,
            "success",
          );
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        feedbackStore.reportError("pdf", err, lang);
      }
    } finally {
      await recordTrace(rootTrace, "pdf.translate.end", {
        outcome: ac.signal.aborted
          ? "cancelled"
          : failed
            ? "fallback"
            : "complete",
        items: subset.length,
      });
      setTranslating(false);
      setProgressText("");
    }
  };

  const allParagraphs = pages.flatMap((p) => p.paragraphs);
  const untranslatedParagraphs = allParagraphs.filter((p) => !p.translation);

  return (
    <div
      style={{
        maxWidth: "var(--content-width)",
        margin: "0 auto",
        padding: "var(--space-6) var(--space-5)",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "var(--space-3)",
          flexWrap: "wrap",
          marginBottom: "var(--space-5)",
        }}
      >
        <div>
          <strong style={{ fontSize: "var(--space-5)" }}>
            {en
              ? "Qingyi · Built-in PDF Translator"
              : "轻译 · 内置 PDF 阅读与翻译"}
          </strong>
          <p class="hint" style={{ margin: "var(--space-1) 0 0" }}>
            {en
              ? "Offline-first PDF text extraction & bilingual translation powered by local pdf.js"
              : "基于内置 pdf.js 提取本地或在线 PDF 文本层，直接复用本地/云端路由、词库与人工修订"}
          </p>
        </div>
        <div class="actions" style={{ marginTop: 0 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            style={{ display: "none" }}
            onChange={(e) => void handleFilePick(e)}
          />
          <Button
            variant="primary"
            busy={store.isBusy("pdf:load")}
            disabled={translating}
            onClick={() => fileInputRef.current?.click()}
          >
            {en ? "Open local PDF…" : "打开本地 PDF 文件…"}
          </Button>
          {pages.length > 0 ? (
            <>
              <Button
                busy={translating}
                disabled={untranslatedParagraphs.length === 0}
                onClick={() =>
                  void translateParagraphSubset(untranslatedParagraphs)
                }
              >
                {en
                  ? `Translate all (${untranslatedParagraphs.length})`
                  : `翻译全文（待译 ${untranslatedParagraphs.length} 段）`}
              </Button>
              {translating ? (
                <Button
                  variant="danger"
                  onClick={() => abortRef.current?.abort()}
                >
                  {en ? "Stop" : "停止"}
                </Button>
              ) : null}
            </>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => {
              location.href = chrome.runtime.getURL("options.html");
            }}
          >
            {en ? "Settings" : "扩展设置"}
          </Button>
        </div>
      </header>

      <FeedbackBanner scope="pdf" lang={lang} />

      {pages.length === 0 ? (
        <VerdictHero
          eyebrow={en ? "PDF READER" : "PDF 双语工作台"}
          title={
            en
              ? "Open any PDF document to read side-by-side with translations"
              : "选择任意本地 PDF 文档即可开启双语对照阅读"
          }
          description={
            en
              ? "No external upload required in local-only mode. Scanned image-only PDFs can be translated with mistral-gui Screenshot OCR."
              : "纯本地模式下 PDF 内容完全不离开本机；若为无文本层的纯扫描版图片 PDF，可配合 mistral-gui 截图 OCR 翻译。"
          }
          actions={
            <Button
              variant="primary"
              onClick={() => fileInputRef.current?.click()}
            >
              {en ? "Choose PDF file" : "选择 PDF 文件"}
            </Button>
          }
        />
      ) : (
        <div
          class="panel"
          style={{
            padding: "var(--space-4) var(--space-5)",
            marginBottom: "var(--space-5)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "var(--space-3)",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
            }}
          >
            <strong>{docTitle}</strong>
            <Badge tone="neutral">
              {en ? `${pages.length} pages` : `共 ${pages.length} 页`}
            </Badge>
            {progressText ? <Badge tone="info">{progressText}</Badge> : null}
          </div>
          <div
            style={{
              display: "flex",
              gap: "var(--space-3)",
              alignItems: "center",
            }}
          >
            <SelectField
              label={en ? "Display" : "显示模式"}
              value={viewMode}
              onValueChange={(v) => setViewMode(v as any)}
            >
              <option value="bilingual">{en ? "Bilingual" : "双语对照"}</option>
              <option value="chinese">
                {en ? "Translated only" : "仅看译文"}
              </option>
              <option value="original">
                {en ? "Original only" : "仅看原文"}
              </option>
            </SelectField>
          </div>
        </div>
      )}

      {pages.map((pg) => (
        <section
          key={pg.pageNumber}
          class="panel"
          style={{ padding: "var(--space-5)", marginBottom: "var(--space-5)" }}
        >
          <div class="split-head" style={{ marginBottom: "var(--space-3)" }}>
            <strong>
              {en ? `Page ${pg.pageNumber}` : `第 ${pg.pageNumber} 页`}
            </strong>
            <div class="actions" style={{ marginTop: 0 }}>
              <Button
                disabled={
                  translating ||
                  pg.paragraphs.every((p) => Boolean(p.translation))
                }
                onClick={() =>
                  void translateParagraphSubset(
                    pg.paragraphs.filter((p) => !p.translation),
                  )
                }
              >
                {en ? "Translate this page" : "翻译本页"}
              </Button>
            </div>
          </div>

          <div
            class="pdf-columns"
            style={{
              display: "grid",

              gap: "var(--space-5)",
              alignItems: "start",
            }}
          >
            <div>
              {pdfDocRef.current ? (
                <PdfCanvasPreview
                  pdfDoc={pdfDocRef.current}
                  pageNumber={pg.pageNumber}
                />
              ) : null}
            </div>
            <div style={{ display: "grid", gap: "var(--space-3)" }}>
              {pg.paragraphs.length === 0 ? (
                <p class="muted">
                  {en
                    ? "No selectable text layer on this page."
                    : "本页未检测到可提取文本层（可能为扫描图片页）。"}
                </p>
              ) : (
                pg.paragraphs.map((para) => (
                  <div
                    key={para.id}
                    class="card"
                    style={{
                      margin: 0,
                      padding: "var(--space-3) var(--space-3)",
                    }}
                  >
                    {viewMode !== "chinese" || !para.translation ? (
                      <p style={{ margin: 0, lineHeight: 1.6 }}>
                        {para.source}
                      </p>
                    ) : null}
                    {viewMode !== "original" && para.translation ? (
                      <p
                        lang={targetLang}
                        style={{
                          margin:
                            viewMode === "bilingual"
                              ? "var(--space-2) 0 0"
                              : "0",
                          paddingTop:
                            viewMode === "bilingual" ? "var(--space-2)" : "0",
                          borderTop:
                            viewMode === "bilingual"
                              ? "1px dashed var(--border)"
                              : "none",
                          color: "var(--color-accent)",
                          lineHeight: 1.65,
                        }}
                      >
                        {para.translation}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      ))}

      <ConfirmModal />
      <ToastHost />
    </div>
  );
}

render(<PdfApp />, document.getElementById("app")!);
