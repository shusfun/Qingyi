import rules from "../shared/translation-rules.json";

export interface RebuiltParagraph {
  merged: string;
  raw: string;
}

export interface RebuildOptions {
  preserveLineBreaks?: boolean;
}

const cfg = rules.paragraphRebuild;
const listMarkerRe = new RegExp(cfg.listMarkerPattern);
const headingSectionRe = new RegExp(cfg.headingSectionPattern);
const headingBlockedEndRe = new RegExp(cfg.headingBlockedEndPattern);
const hyphenLineEndRe = new RegExp(cfg.hyphenLineEndPattern);
const hyphenNextStartRe = new RegExp(cfg.hyphenNextStartPattern);
const codeFenceRe = new RegExp(cfg.codeFencePattern);
const codeLineRe = new RegExp(cfg.codeLinePattern);
const cjkCharRe = new RegExp(cfg.cjkCharPattern);
const trailingAsciiHyphenRe = /[A-Za-z]-$/;
const startsLowerAsciiRe = /^[a-z]/;

function codePointLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function firstCodePoint(s: string): string {
  for (const ch of s) return ch;
  return "";
}

function lastCodePoint(s: string): string {
  let last = "";
  for (const ch of s) last = ch;
  return last;
}

function isStandaloneHeading(
  prevTrimmed: string,
  currTrimmed: string,
  accumulatedLines: number,
): boolean {
  if (accumulatedLines > 1) return false;
  if (listMarkerRe.test(prevTrimmed)) return false;
  if (headingBlockedEndRe.test(prevTrimmed)) return false;
  if (startsLowerAsciiRe.test(currTrimmed)) return false;

  const prevLen = codePointLen(prevTrimmed);
  if (
    headingSectionRe.test(prevTrimmed) &&
    prevLen <= cfg.headingMaxChars * 2
  ) {
    return true;
  }

  const hasCjk = cjkCharRe.test(prevTrimmed);
  const maxLen = hasCjk ? cfg.headingMaxCjkChars : cfg.headingMaxChars;
  const shortLen = hasCjk ? cfg.headingShortCjkChars : cfg.headingShortChars;
  if (prevLen > maxLen) return false;
  if (prevLen <= shortLen) return true;

  const currLen = codePointLen(currTrimmed);
  return currLen > 0 && prevLen / currLen <= cfg.headingMaxRatio;
}

function shouldKeepLineBreak(
  prevTrimmed: string,
  currTrimmed: string,
  accumulatedLines: number,
): boolean {
  if (codeLineRe.test(prevTrimmed) || codeLineRe.test(currTrimmed)) return true;
  if (listMarkerRe.test(currTrimmed)) return true;
  if (isStandaloneHeading(prevTrimmed, currTrimmed, accumulatedLines)) {
    return true;
  }
  return false;
}

export function mergeTwoLines(
  mergedSoFar: string,
  nextTrimmed: string,
): string {
  if (!mergedSoFar) return nextTrimmed;
  if (!nextTrimmed) return mergedSoFar;

  if (
    hyphenLineEndRe.test(mergedSoFar) &&
    hyphenNextStartRe.test(nextTrimmed)
  ) {
    return mergedSoFar.slice(0, -1) + nextTrimmed;
  }
  if (trailingAsciiHyphenRe.test(mergedSoFar)) {
    return mergedSoFar + nextTrimmed;
  }

  const lastCh = lastCodePoint(mergedSoFar);
  const firstCh = firstCodePoint(nextTrimmed);
  if (cjkCharRe.test(lastCh) || cjkCharRe.test(firstCh)) {
    return mergedSoFar + nextTrimmed;
  }
  return mergedSoFar + " " + nextTrimmed;
}

export function rebuildParagraphs(
  input: string,
  options?: RebuildOptions,
): RebuiltParagraph[] {
  const norm = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = norm.split("\n");

  if (options?.preserveLineBreaks) {
    const out: RebuiltParagraph[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (t) out.push({ merged: t, raw: t });
    }
    return out;
  }

  const out: RebuiltParagraph[] = [];
  let inCodeFence = false;
  let acc: { merged: string; rawLines: string[]; prevTrimmed: string } | null =
    null;

  const flush = () => {
    if (!acc) return;
    out.push({ merged: acc.merged, raw: acc.rawLines.join("\n") });
    acc = null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (codeFenceRe.test(trimmed)) {
      flush();
      out.push({ merged: trimmed, raw: trimmed });
      inCodeFence = !inCodeFence;
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    if (inCodeFence) {
      flush();
      out.push({ merged: trimmed, raw: trimmed });
      continue;
    }
    if (!acc) {
      acc = { merged: trimmed, rawLines: [trimmed], prevTrimmed: trimmed };
      continue;
    }
    if (shouldKeepLineBreak(acc.prevTrimmed, trimmed, acc.rawLines.length)) {
      flush();
      acc = { merged: trimmed, rawLines: [trimmed], prevTrimmed: trimmed };
    } else {
      acc.merged = mergeTwoLines(acc.merged, trimmed);
      acc.rawLines.push(trimmed);
      acc.prevTrimmed = trimmed;
    }
  }
  flush();
  return out;
}
