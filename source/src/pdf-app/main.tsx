import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import * as pdfjsLib from "pdfjs-dist";
import "../../design-system/tokens.css";
import "../../design-system/components.css";
import "./pdf.css";
import {
  Badge,
  Button,
  ConfirmHost,
  FeedbackBanner,
  IconFileText,
  IconSettings,
  IconSquare,
  IconTranslate,
  IconUpload,
  SegmentedControl,
  ToastViewport,
  applyTheme,
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
        border: "1px solid var(--color-border)",
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
        applyTheme(cfg["ui.theme"] || "system");
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
                : "由于浏览器限制直接读取 file:// 链接，请点击「打开 PDF」选择该文件即可离线阅读与翻译。",
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
          ? `Loaded "${label}" (${doc.numPages} page(s), ${totalParas} paragraph(s)).`
          : `已加载「${label}」（共 ${doc.numPages} 页，提取 ${totalParas} 个段落）。`,
      });
    });
  };

  const handleFileBytes = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await loadPdfFromSource({ data: bytes }, file.name);
  };

  const handleFilePick = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    await handleFileBytes(file);
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
          en ? `${done}/${subset.length}` : `翻译中 ${done} / ${subset.length}`,
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
        } else {
          toast(
            en
              ? `Translated ${subset.length} paragraph(s).`
              : `已完成 ${subset.length} 个段落翻译。`,
            "success",
          );
        }
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
      class="pdf-shell"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file && file.name.toLowerCase().endsWith(".pdf")) {
          void handleFileBytes(file);
        }
      }}
    >
      <header class="pdf-topbar">
        <div class="pdf-topbar-left">
          <span class="pdf-brand">
            <img src="./icons/logo.svg" alt="" />
            <span>{en ? "Qingyi PDF" : "轻译 · PDF 阅读"}</span>
          </span>
          {docTitle ? (
            <>
              <span class="muted">·</span>
              <strong style={{ fontSize: "var(--font-sm)" }}>{docTitle}</strong>
              <Badge tone="neutral">
                {en ? `${pages.length}p` : `${pages.length} 页`}
              </Badge>
            </>
          ) : null}
          {progressText ? <Badge tone="info">{progressText}</Badge> : null}
        </div>

        <div class="pdf-topbar-right">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            style={{ display: "none" }}
            onChange={(e) => void handleFilePick(e)}
          />
          {pages.length > 0 ? (
            <SegmentedControl
              value={viewMode}
              onChange={(v) => setViewMode(v)}
              options={[
                { value: "bilingual", label: en ? "Bilingual" : "双语对照" },
                { value: "chinese", label: en ? "Translated" : "仅看译文" },
                { value: "original", label: en ? "Original" : "仅看原文" },
              ]}
            />
          ) : null}
          <Button
            variant={pages.length === 0 ? "primary" : "secondary"}
            size="sm"
            icon={<IconUpload size={14} />}
            busy={store.isBusy("pdf:load")}
            disabled={translating}
            onClick={() => fileInputRef.current?.click()}
          >
            {en ? "Open PDF" : "打开 PDF"}
          </Button>
          {pages.length > 0 ? (
            <>
              <Button
                variant="primary"
                size="sm"
                icon={<IconTranslate size={14} />}
                busy={translating}
                disabled={untranslatedParagraphs.length === 0}
                onClick={() =>
                  void translateParagraphSubset(untranslatedParagraphs)
                }
              >
                {en
                  ? `Translate (${untranslatedParagraphs.length})`
                  : `翻译全文（${untranslatedParagraphs.length}）`}
              </Button>
              {translating ? (
                <Button
                  variant="danger"
                  size="sm"
                  icon={<IconSquare size={13} />}
                  onClick={() => abortRef.current?.abort()}
                >
                  {en ? "Stop" : "停止"}
                </Button>
              ) : null}
            </>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            icon={<IconSettings size={14} />}
            onClick={() => {
              location.href = chrome.runtime.getURL("options.html");
            }}
          >
            {en ? "Settings" : "设置"}
          </Button>
        </div>
      </header>

      <main class="pdf-main">
        <FeedbackBanner scope="pdf" lang={lang} />

        {pages.length === 0 ? (
          <div
            class="pdf-dropzone"
            onClick={() => fileInputRef.current?.click()}
            style={{ cursor: "pointer" }}
          >
            <span class="pdf-dropzone-icon">
              <IconFileText size={24} />
            </span>
            <strong style={{ fontSize: "var(--font-lg)" }}>
              {en
                ? "Drop a PDF file here, or click to browse"
                : "拖拽 PDF 文件到此处，或点击选择本地文档"}
            </strong>
            <p class="muted" style={{ maxWidth: "460px", margin: 0 }}>
              {en
                ? "Extracts selectable text offline via built-in pdf.js and translates side-by-side using your configured local or cloud service."
                : "基于内置 pdf.js 离线提取文本层进行双语对照阅读；纯本地模式下文档内容完全不离开本机。"}
            </p>
            <Button
              variant="primary"
              icon={<IconUpload size={14} />}
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
            >
              {en ? "Choose PDF File" : "选择 PDF 文件"}
            </Button>
          </div>
        ) : (
          pages.map((pg) => (
            <section key={pg.pageNumber} class="pdf-page-card">
              <div class="split-head" style={{ marginBottom: "14px" }}>
                <strong>
                  {en ? `Page ${pg.pageNumber}` : `第 ${pg.pageNumber} 页`}
                </strong>
                <Button
                  size="sm"
                  icon={<IconTranslate size={13} />}
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
                  {en ? "Translate page" : "翻译本页"}
                </Button>
              </div>

              <div class="pdf-columns">
                <div>
                  {pdfDocRef.current ? (
                    <PdfCanvasPreview
                      pdfDoc={pdfDocRef.current}
                      pageNumber={pg.pageNumber}
                    />
                  ) : null}
                </div>
                <div style={{ display: "grid", gap: "10px" }}>
                  {pg.paragraphs.length === 0 ? (
                    <p class="muted">
                      {en
                        ? "No selectable text layer on this page."
                        : "本页未检测到可提取文本层（扫描图片页可使用 mistral 截图 OCR 翻译）。"}
                    </p>
                  ) : (
                    pg.paragraphs.map((para) => (
                      <div key={para.id} class="pdf-para-card">
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
                                viewMode === "bilingual" ? "8px 0 0" : "0",
                              paddingTop:
                                viewMode === "bilingual" ? "8px" : "0",
                              borderTop:
                                viewMode === "bilingual"
                                  ? "1px solid var(--color-border)"
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
          ))
        )}
      </main>

      <ConfirmHost lang={lang} />
      <ToastViewport />
    </div>
  );
}

render(<PdfApp />, document.getElementById("app")!);
