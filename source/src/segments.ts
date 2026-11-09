// Preserve every source character and avoid splitting protected placeholders.
export function splitSegments(source: string, limit = 900): string[] {
  if (source.length <= limit) return [source];
  const protectedRanges = [
    ...source.matchAll(
      /__QY\d+__|https?:\/\/[^\s<>"）)]+|\{\{[^{}]+\}\}|\$\{[^{}]+\}|%[sdif]|\{[a-zA-Z_]\w*\}/g,
    ),
  ].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
  const out: string[] = [];
  let start = 0;
  while (source.length - start > limit) {
    const end = start + limit;
    const candidate = source.slice(start, end);
    // Prefer sentence boundaries; use a word boundary for a very long sentence.
    const sentence = [...candidate.matchAll(/[.!?。！？;；]\s+|\n+/g)].at(-1);
    const word = [...candidate.matchAll(/\s+/g)].at(-1);
    let cut =
      sentence && sentence.index! > limit / 3
        ? start + sentence.index! + sentence[0].length
        : word && word.index! > limit / 3
          ? start + word.index! + word[0].length
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
