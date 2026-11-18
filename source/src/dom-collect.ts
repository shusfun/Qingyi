export const BASE_SKIP_SELECTOR =
  'script,style,noscript,textarea,input,select,option,svg,math,canvas,pre,code,kbd,samp,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[data-qingyi],.sr-only,.visually-hidden,.highlight,.hljs,.prismjs,.shiki,.monaco-editor,.cm-editor,.CodeMirror,.blob-code,.blob-code-inner,[data-code-block],[class*="code-block"]';

export const BLOCK_SELECTOR =
  "p,li,h1,h2,h3,h4,h5,h6,td,th,button,label,figcaption,blockquote,dt,dd,summary";

export const STRUCTURAL_CHILD_SELECTOR =
  BLOCK_SELECTOR +
  ",div,section,article,main,ul,ol,dl,table,thead,tbody,tr,nav,aside,header,footer,form,fieldset,details,figure";

export const INLINE_INTERACTIVE_TAGS = new Set([
  "A",
  "BUTTON",
  "LABEL",
  "SPAN",
  "SUMMARY",
  "TH",
  "TD",
]);

export function buildSkipSelector(extraSelector?: string): string {
  const trimmed = (extraSelector || "").trim();
  if (!trimmed) return BASE_SKIP_SELECTOR;
  try {
    if (typeof document !== "undefined") {
      document.createDocumentFragment().querySelector(trimmed);
    }
    return `${BASE_SKIP_SELECTOR},${trimmed}`;
  } catch {
    return BASE_SKIP_SELECTOR;
  }
}

export function isTextUseful(s: string, targetLang = "zh-CN"): boolean {
  const trimmed = s.trim();
  if (trimmed.length <= 1) return false;
  if (
    !/[a-z\u00c0-\u024f\u0370-\u052f\u0600-\u06ff\u3040-\u30ff\uac00-\ud7af\u3400-\u9fff]/i.test(
      trimmed,
    )
  ) {
    return false;
  }
  if (/^\s*(https?:\/\/|www\.|\S+@\S+\.\S+$)/i.test(trimmed)) {
    return false;
  }
  const latin = (trimmed.match(/[a-z]/gi) || []).length;
  const han = (trimmed.match(/[\u3400-\u9fff]/g) || []).length;
  const kanaHangul = /[\u3040-\u30ff\uac00-\ud7af]/.test(trimmed);

  if (targetLang.startsWith("zh")) {
    return latin > han * 2 || kanaHangul || (!han && trimmed.length > 1);
  }
  if (targetLang === "en") {
    return (
      han > 0 ||
      kanaHangul ||
      /[\u00c0-\u024f\u0370-\u052f\u0600-\u06ff]/.test(trimmed)
    );
  }
  return true;
}

export function isVisuallyHiddenElement(el: Element): boolean {
  if (el.closest('[hidden],[aria-hidden="true"]')) return true;
  if (typeof getComputedStyle === "function") {
    try {
      const cs = getComputedStyle(el);
      if (
        cs.display === "none" ||
        cs.visibility === "hidden" ||
        cs.visibility === "collapse"
      ) {
        return true;
      }
      if (
        cs.position === "absolute" &&
        cs.overflow === "hidden" &&
        (cs.clip !== "auto" || cs.clipPath !== "none") &&
        parseFloat(cs.width) <= 2 &&
        parseFloat(cs.height) <= 2
      ) {
        return true;
      }
    } catch {
      // ignore detached/mock nodes
    }
  }
  return false;
}

export interface TextPart {
  node: Text;
  original: string;
  current: string;
  token: string;
}

export interface ExtractedGroup {
  kind: "element" | "inline-run";
  el: Element;
  anchorNode?: Node;
  parts: TextPart[];
  source: string;
}

export function extractTextPartsFromNodes(
  nodes: Node[],
  skipSelector: string,
): { parts: TextPart[]; source: string } | null {
  const parts: TextPart[] = [];
  let source = "";

  const visit = (node: Node) => {
    if (node.nodeType === 3 /* Node.TEXT_NODE */) {
      const textNode = node as Text;
      if (textNode.parentElement?.closest(skipSelector)) return;
      if (!textNode.data?.trim()) return;
      const token = "__QY" + parts.length + "__";
      parts.push({
        node: textNode,
        original: textNode.data,
        current: textNode.data,
        token,
      });
      source += token + textNode.data;
      return;
    }
    if (node.nodeType === 1 /* Node.ELEMENT_NODE */) {
      const el = node as Element;
      if (el.matches(skipSelector) || isVisuallyHiddenElement(el)) return;
      for (const child of Array.from(el.childNodes)) {
        visit(child);
      }
    }
  };

  for (const n of nodes) visit(n);

  if (!parts.length) return null;
  if (parts.length === 1) {
    parts[0].token = "";
    source = parts[0].original.trim();
  }
  if (source.length > 24000) return null;
  return { parts, source };
}

// Inspects an element and returns extracted text groups + child elements to continue traversing (fixes Q-T01).
export function inspectDomElement(
  el: Element,
  skipSelector: string,
  targetLang = "zh-CN",
): { groups: ExtractedGroup[]; descendInto: Element[] } {
  if (el.closest(skipSelector) || isVisuallyHiddenElement(el)) {
    return { groups: [], descendInto: [] };
  }

  const children = Array.from(el.children);
  const hasStructuralChild = children.some(
    (c) => !c.matches(skipSelector) && c.matches(STRUCTURAL_CHILD_SELECTOR),
  );

  if (
    !hasStructuralChild &&
    el.matches(BLOCK_SELECTOR + ",div,section,article,main,span,a")
  ) {
    const extracted = extractTextPartsFromNodes([el], skipSelector);
    if (
      extracted &&
      isTextUseful(extracted.parts.map((p) => p.original).join(" "), targetLang)
    ) {
      return {
        groups: [
          {
            kind: "element",
            el,
            parts: extracted.parts,
            source: extracted.source,
          },
        ],
        descendInto: [],
      };
    }
    return { groups: [], descendInto: [] };
  }

  // Element contains structural/block children (e.g. <li>Category<ul>...</ul></li> or <div>Header<p>...</p></div>):
  // group consecutive direct inline/text child nodes into inline-run units AND descend into structural children!
  const groups: ExtractedGroup[] = [];
  const descendInto: Element[] = [];
  let inlineRun: Node[] = [];

  const flushInlineRun = () => {
    if (!inlineRun.length) return;
    const runNodes = inlineRun;
    inlineRun = [];
    const extracted = extractTextPartsFromNodes(runNodes, skipSelector);
    if (
      extracted &&
      isTextUseful(extracted.parts.map((p) => p.original).join(" "), targetLang)
    ) {
      groups.push({
        kind: "inline-run",
        el,
        anchorNode: runNodes[runNodes.length - 1],
        parts: extracted.parts,
        source: extracted.source,
      });
    }
  };

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      if (child.textContent?.trim()) inlineRun.push(child);
      else if (inlineRun.length) inlineRun.push(child);
      continue;
    }
    if (child.nodeType === 1 /* ELEMENT_NODE */) {
      const childEl = child as Element;
      if (childEl.matches(skipSelector) || isVisuallyHiddenElement(childEl)) {
        flushInlineRun();
        continue;
      }
      if (childEl.matches(STRUCTURAL_CHILD_SELECTOR)) {
        flushInlineRun();
        descendInto.push(childEl);
      } else {
        inlineRun.push(childEl);
      }
    }
  }
  flushInlineRun();

  return { groups, descendInto };
}

// Readability-inspired main content root detector for "只翻译正文" site rule (Prompt item 13).
export const NON_ARTICLE_CHROME_SELECTOR =
  'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],.sidebar,.site-header,.site-footer,.navbar,.breadcrumb,.comments,#comments';

export function detectMainArticleRoot(doc: Document): Element {
  const body = doc.body;
  if (!body) return doc.documentElement;
  const bodyLen = (body.textContent || "").trim().length || 1;

  for (const sel of ["article", "main", '[role="main"]']) {
    const candidates = Array.from(body.querySelectorAll(sel)).filter(
      (el) => !el.closest("aside,nav,footer"),
    );
    if (candidates.length === 1) {
      const len = (candidates[0].textContent || "").trim().length;
      if (len >= Math.min(400, bodyLen * 0.25)) return candidates[0];
    }
  }

  let best: Element = body;
  let bestScore = -1;

  const containers = Array.from(
    body.querySelectorAll("article,main,section,div"),
  );
  for (const el of containers) {
    if (el.closest(NON_ARTICLE_CHROME_SELECTOR)) continue;
    const clsId = `${el.tagName} ${el.id} ${el.className}`.toLowerCase();
    if (
      /\b(nav|menu|sidebar|footer|header|comment|widget|toolbar|modal)\b/.test(
        clsId,
      )
    ) {
      continue;
    }
    const paragraphs = el.querySelectorAll("p,li,blockquote,h1,h2,h3");
    if (paragraphs.length < 2) continue;
    const totalLen = (el.textContent || "").trim().length;
    if (totalLen < 200) continue;
    let linkLen = 0;
    for (const a of Array.from(el.querySelectorAll("a"))) {
      linkLen += (a.textContent || "").trim().length;
    }
    const linkDensity = linkLen / totalLen;
    if (linkDensity > 0.5) continue;

    let score = totalLen * (1 - linkDensity) + paragraphs.length * 45;
    if (
      /\b(article|post|entry|content|markdown|prose|story|main)\b/.test(clsId)
    ) {
      score *= 1.35;
    }
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}
