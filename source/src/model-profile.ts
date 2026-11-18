import rules from "../shared/translation-rules.json";

export interface TargetLanguageSpec {
  code: string;
  zhLabel: string;
  enLabel: string;
  hunyuanName: string;
  promptName: string;
}

export const TRANSLATION_RULES = rules;
export const SPLIT_LIMIT: number = rules.splitLimit;
export const PLACEHOLDER_PATTERN_SOURCE: string = rules.placeholderPattern;
export const TARGET_LANGUAGES: readonly TargetLanguageSpec[] =
  rules.targetLanguages;

const singleTextRegex = new RegExp(rules.singleTextModelPattern, "i");

export const singleTextModel = (model: string): boolean =>
  singleTextRegex.test(model);

export function resolveTargetLanguage(code?: string): TargetLanguageSpec {
  const found = TARGET_LANGUAGES.find((item) => item.code === code);
  return found || TARGET_LANGUAGES[0];
}

export function translationPolicy(model: string): string {
  const spec = singleTextModel(model)
    ? rules.policies.hunyuanMt
    : rules.policies.default;
  return spec.templateVersion > 1
    ? `${spec.id}-tv${spec.templateVersion}`
    : spec.id;
}

export function translationPrompt(
  model: string,
  sources: string[],
  targetLang = "zh-CN",
): string {
  const lang = resolveTargetLanguage(targetLang);
  if (singleTextModel(model)) {
    if (sources.length !== 1) throw Error("SINGLE_TEXT_MODEL");
    return rules.templates.hunyuanSingle
      .replace("{{hunyuanName}}", lang.hunyuanName)
      .replace("{{source}}", () => sources[0]);
  }
  const batch = sources.length > 1;
  if (batch) {
    const jsonSources = JSON.stringify(
      sources.map((text, i) => ({ id: "t" + i, text })),
    );
    return rules.templates.defaultBatch
      .replace("{{promptName}}", lang.promptName)
      .replace("{{jsonSources}}", () => jsonSources);
  }
  return rules.templates.defaultSingle
    .replace("{{promptName}}", lang.promptName)
    .replace("{{source}}", () => sources[0]);
}
