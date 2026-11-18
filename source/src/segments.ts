import { PLACEHOLDER_PATTERN_SOURCE, SPLIT_LIMIT } from "./model-profile";

// Preserve every source character, support CJK sentence boundaries without trailing spaces (Q-T12),
// and avoid splitting protected placeholders or URLs with trailing punctuation stripped (Q-T07).
export function splitSegments(source: string, limit = SPLIT_LIMIT): string[] {
  if (source.length <= limit) return [source];
  const placeholderRe = new RegExp(PLACEHOLDER_PATTERN_SOURCE, "g");
  const protectedRanges = [...source.matchAll(placeholderRe)].map((m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
  }));
  const out: string[] = [];
  let start = 0;
  while (source.length - start > limit) {
    const end = start + limit;
    const candidate = source.slice(start, end);
    // Prefer sentence boundaries: CJK sentence-end punctuation needs no trailing space;
    // ASCII sentence punctuation requires trailing whitespace or newline.
    const sentence = [
      ...candidate.matchAll(/[。！？；]+[”’」』）】]*|[.!?;]+\s+|\n+/g),
    ].at(-1);
    const clauseOrWord = [
      ...candidate.matchAll(/[，、：]+[”’」』）】]*|\s+/g),
    ].at(-1);
    let cut =
      sentence && sentence.index! > limit / 3
        ? start + sentence.index! + sentence[0].length
        : clauseOrWord && clauseOrWord.index! > limit / 3
          ? start + clauseOrWord.index! + clauseOrWord[0].length
          : end;
    const protectedRange = protectedRanges.find(
      (r) => r.start < cut && r.end > cut,
    );
    if (protectedRange)
      cut =
        protectedRange.start > start
          ? protectedRange.start
          : protectedRange.end;
    if (cut > start && /[\uD800-\uDBFF]/.test(source[cut - 1])) cut--;
    if (cut <= start) cut = end;
    out.push(source.slice(start, cut));
    start = cut;
  }
  if (start < source.length) out.push(source.slice(start));
  return out;
}
