import { useEffect, useState } from "preact/hooks";
import {
  Badge,
  Button,
  DataList,
  Disclosure,
  FeedbackBanner,
  Select,
  Switch,
  TextInput,
  VerdictHero,
  confirmAction,
  feedbackStore,
  runTracked,
  toast,
  useFeedbackStore,
  type UiLang,
} from "../../design-system";
import sharedRules from "../../shared/translation-rules.json";
import type { SiteRule, TranslationStyleConfig } from "../types";
import {
  applyThemeDom,
  grantOriginsOnce,
  runTracedUiOp,
  scopedRpc,
} from "./rpc";
import type { SettingsView, Theme } from "./types";

const DEFAULT_STYLE: Required<TranslationStyleConfig> = {
  preset: "default",
  opacity: 0.92,
  gapPx: 3,
  strokePx: 3,
  insetPx: 7,
};

export function ReadingSection({
  config,
  onSavedConfig,
  lang,
}: {
  config: SettingsView;
  onSavedConfig: (next: SettingsView) => void;
  lang: UiLang;
}) {
  const store = useFeedbackStore();
  const en = lang === "en";

  const [mode, setMode] = useState<"chinese" | "bilingual">(config.mode);
  const [targetLang, setTargetLang] = useState<string>(
    config.targetLang || "zh-CN",
  );
  const [translateAttributes, setTranslateAttributes] = useState<boolean>(
    config.translateAttributes !== false,
  );
  const [theme, setTheme] = useState<Theme>(config["ui.theme"] || "system");
  const [locale, setLocale] = useState<"zh-CN" | "en">(
    config["ui.locale"] || "zh-CN",
  );
  const [progressVisible, setProgressVisible] = useState<boolean>(
    config["ui.progressVisible"] !== false,
  );
  const [styleCfg, setStyleCfg] = useState<Required<TranslationStyleConfig>>({
    ...DEFAULT_STYLE,
    ...(config["ui.translationStyle"] || {}),
  });

  // Per-site rule form state
  const [siteOrigin, setSiteOrigin] = useState("");
  const [siteBehavior, setSiteBehavior] =
    useState<NonNullable<SiteRule["mode"]>>("auto");
  const [siteDisplay, setSiteDisplay] = useState<"" | "chinese" | "bilingual">(
    "",
  );
  const [siteRouting, setSiteRouting] = useState<
    "" | "local-first" | "local-only" | "cloud-only"
  >("");
  const [siteSourceLang, setSiteSourceLang] = useState("");
  const [siteArticleOnly, setSiteArticleOnly] = useState(false);
  const [siteSkipSelector, setSiteSkipSelector] = useState("");
  const [lastRemovedSite, setLastRemovedSite] = useState<{
    origin: string;
    rule: SiteRule;
  } | null>(null);

  const [fileAccessAllowed, setFileAccessAllowed] = useState<boolean | null>(
    null,
  );
  const [commands, setCommands] = useState<chrome.commands.Command[]>([]);

  useEffect(() => {
    setMode(config.mode);
    setTargetLang(config.targetLang || "zh-CN");
    setTranslateAttributes(config.translateAttributes !== false);
    setTheme(config["ui.theme"] || "system");
    setLocale(config["ui.locale"] || "zh-CN");
    setProgressVisible(config["ui.progressVisible"] !== false);
    setStyleCfg({
      ...DEFAULT_STYLE,
      ...(config["ui.translationStyle"] || {}),
    });
  }, [config]);

  useEffect(() => {
    try {
      chrome.extension?.isAllowedFileSchemeAccess?.((allowed) => {
        setFileAccessAllowed(Boolean(allowed));
      });
    } catch {
      setFileAccessAllowed(null);
    }
    try {
      chrome.commands?.getAll?.((list) => {
        setCommands(list || []);
      });
    } catch {
      // ignore in non-extension test environments
    }
  }, []);

  const handleSaveReading = () =>
    runTracked({ key: "reading:save", scope: "reading", lang }, async () => {
      await runTracedUiOp("reading-save", async (t) => {
        const rpc = scopedRpc(t);
        await rpc.send("SAVE", {
          config: {
            mode,
            targetLang,
            translateAttributes,
          },
          trace: t,
        });
        await rpc.send("PREFERENCES", {
          translationStyle: styleCfg,
        });
        onSavedConfig(await rpc.send<SettingsView>("PRIVATE"));
      });
      toast(
        en ? "Reading preferences saved." : "阅读、目标语言与译文样式已保存。",
        "success",
      );
    });

  // Q-51: Immediate preference save with automatic rollback + error banner if persistence fails!
  const handleImmediatePref = async (patch: {
    nextTheme?: Theme;
    nextVisible?: boolean;
    nextLocale?: "zh-CN" | "en";
  }) => {
    const prevTheme = theme;
    const prevVisible = progressVisible;
    const prevLocale = locale;

    if (patch.nextTheme !== undefined) {
      setTheme(patch.nextTheme);
      applyThemeDom(patch.nextTheme);
    }
    if (patch.nextVisible !== undefined) setProgressVisible(patch.nextVisible);
    if (patch.nextLocale !== undefined) setLocale(patch.nextLocale);

    try {
      await runTracedUiOp("preferences-save", async (t) => {
        const rpc = scopedRpc(t);
        await rpc.send("PREFERENCES", {
          theme: patch.nextTheme ?? prevTheme,
          visible: patch.nextVisible ?? prevVisible,
          locale: patch.nextLocale ?? prevLocale,
        });
        onSavedConfig(await rpc.send<SettingsView>("PRIVATE"));
      });
      toast(
        en ? "Appearance preference updated." : "界面外观与显示偏好已更新。",
        "success",
      );
    } catch (err) {
      // Roll back optimistic state on failure (Q-51)
      setTheme(prevTheme);
      applyThemeDom(prevTheme);
      setProgressVisible(prevVisible);
      setLocale(prevLocale);
      feedbackStore.reportError("reading", err, lang);
    }
  };

  const siteEntries = Object.entries(config.siteRules || {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  const handleSaveSiteRule = () =>
    runTracked(
      { key: "reading:site-save", scope: "reading", lang },
      async () => {
        let normalizedOrigin: string;
        try {
          const u = new URL(siteOrigin.trim());
          normalizedOrigin = u.origin;
        } catch {
          throw new Error("INVALID_ENDPOINT");
        }
        const rule: SiteRule = {
          mode: siteBehavior,
          ...(siteDisplay ? { display: siteDisplay } : {}),
          ...(siteRouting ? { routing: siteRouting } : {}),
          ...(siteSourceLang.trim()
            ? { sourceLang: siteSourceLang.trim() }
            : {}),
          ...(siteArticleOnly ? { articleOnly: true } : {}),
          ...(siteSkipSelector.trim()
            ? { skipSelector: siteSkipSelector.trim() }
            : {}),
        };
        await runTracedUiOp("site-rule-save", async (t) => {
          if (siteBehavior === "auto") {
            await grantOriginsOnce([normalizedOrigin], t);
          }
          const rpc = scopedRpc(t);
          await rpc.send("SAVE_SITE_RULE", { origin: normalizedOrigin, rule });
          onSavedConfig(await rpc.send<SettingsView>("PRIVATE"));
        });
        setSiteOrigin("");
        setSiteSkipSelector("");
        setSiteSourceLang("");
        setSiteArticleOnly(false);
        setSiteDisplay("");
        setSiteRouting("");
        toast(
          en
            ? `Saved site rule for ${normalizedOrigin}.`
            : `已保存网站规则：${normalizedOrigin}`,
          "success",
        );
      },
    );

  // Q-48: Confirm before deleting site rule AND retain undo snapshot!
  const handleRemoveSite = async (origin: string, existingRule: SiteRule) => {
    const ok = await confirmAction({
      message: en
        ? `Remove custom rule for ${origin}?`
        : `确定移除 ${origin} 的站点翻译规则吗？`,
      lang,
    });
    if (!ok) return;
    await runTracked(
      { key: `site:remove:${origin}`, scope: "reading", lang },
      async () => {
        await runTracedUiOp("remove-site", async (t) => {
          const rpc = scopedRpc(t);
          await rpc.send("REMOVE_SITE", { origin });
          onSavedConfig(await rpc.send<SettingsView>("PRIVATE"));
        });
        setLastRemovedSite({ origin, rule: existingRule });
        toast(
          en ? `Removed rule for ${origin}.` : `已移除 ${origin} 的规则。`,
          "info",
        );
      },
    );
  };

  const targetLangOptions = sharedRules.targetLanguages.map((l) => ({
    value: l.code,
    label: en ? `${l.enLabel} (${l.code})` : `${l.zhLabel} (${l.code})`,
  }));

  return (
    <section class="page panel">
      <VerdictHero
        eyebrow={en ? "READING EXPERIENCE" : "当前阅读偏好"}
        title={
          mode === "bilingual"
            ? en
              ? "Bilingual comparison · Embedded inside original blocks"
              : "双语对照模式 · 译文嵌在原段落内部，不破坏表格与布局"
            : en
              ? "Translated view · Hover or click to peek original text"
              : "译文模式 · 悬停可预览原文，Alt+点击可单段切换原文"
        }
        badge={
          <Badge tone="neutral">
            {targetLangOptions.find((o) => o.value === targetLang)?.label ||
              targetLang}
          </Badge>
        }
        metrics={[
          {
            label: en ? "Site rules" : "站点规则数",
            value: String(siteEntries.length),
          },
          {
            label: en ? "Attribute translation" : "属性文本翻译",
            value: translateAttributes
              ? en
                ? "On"
                : "开启"
              : en
                ? "Off"
                : "关闭",
          },
          {
            label: en ? "Local file / PDF" : "本地文件权限",
            value:
              fileAccessAllowed === null
                ? en
                  ? "Unknown"
                  : "未知"
                : fileAccessAllowed
                  ? en
                    ? "Granted"
                    : "已开启"
                  : en
                    ? "Not enabled"
                    : "未开启",
          },
        ]}
      />

      <FeedbackBanner scope="reading" lang={lang} />

      <fieldset>
        <legend>{en ? "Language & Display Mode" : "目标语言与显示方式"}</legend>
        <div class="grid">
          <Select
            label={en ? "Target translation language" : "默认目标语言"}
            value={targetLang}
            options={targetLangOptions}
            onValueChange={(v) => setTargetLang(v)}
          />
          <Select
            label={en ? "Default reading mode" : "默认显示方式"}
            value={mode}
            options={[
              {
                value: "chinese",
                label: en ? "Translated text mode" : "译文模式（悬停可看原文）",
              },
              {
                value: "bilingual",
                label: en ? "Bilingual side-by-side" : "双语对照（段落内嵌）",
              },
            ]}
            onValueChange={(v) => setMode(v as "chinese" | "bilingual")}
          />
        </div>

        <Switch
          checked={translateAttributes}
          onChange={(v) => setTranslateAttributes(v)}
          label={
            en
              ? "Translate placeholder, title, alt, and aria-label attributes"
              : "同时翻译输入框提示（placeholder）、按钮提示（title / aria-label）与图片说明（alt）"
          }
          hint={
            en
              ? "Restoring original page restores all original attributes cleanly."
              : "点击「恢复原文」时会完整还原所有原始属性值。"
          }
        />

        <Disclosure
          summary={
            en ? "Bilingual Style & Live Preview" : "双语对照样式微调与实时预览"
          }
        >
          <div class="grid">
            <TextInput
              label={
                en
                  ? `Translation opacity (${styleCfg.opacity})`
                  : `译文不透明度（${styleCfg.opacity}）`
              }
              type="number"
              min={0.5}
              max={1}
              step={0.02}
              value={styleCfg.opacity}
              onValueInput={(v) =>
                setStyleCfg((s) => ({
                  ...s,
                  opacity: Math.min(1, Math.max(0.5, Number(v) || 0.92)),
                }))
              }
            />
            <TextInput
              label={
                en
                  ? `Vertical spacing (${styleCfg.gapPx}px)`
                  : `原文与译文间距（${styleCfg.gapPx}px）`
              }
              type="number"
              min={0}
              max={16}
              step={1}
              value={styleCfg.gapPx}
              onValueInput={(v) =>
                setStyleCfg((s) => ({
                  ...s,
                  gapPx: Math.min(16, Math.max(0, Math.round(Number(v) || 0))),
                }))
              }
            />
            <TextInput
              label={
                en
                  ? `Quote bar width (${styleCfg.strokePx}px)`
                  : `左侧引线粗细（${styleCfg.strokePx}px）`
              }
              type="number"
              min={0}
              max={6}
              step={1}
              value={styleCfg.strokePx}
              onValueInput={(v) =>
                setStyleCfg((s) => ({
                  ...s,
                  strokePx: Math.min(
                    6,
                    Math.max(0, Math.round(Number(v) || 0)),
                  ),
                }))
              }
            />
            <TextInput
              label={
                en
                  ? `Left inset (${styleCfg.insetPx}px)`
                  : `译文左内边距（${styleCfg.insetPx}px）`
              }
              type="number"
              min={0}
              max={20}
              step={1}
              value={styleCfg.insetPx}
              onValueInput={(v) =>
                setStyleCfg((s) => ({
                  ...s,
                  insetPx: Math.min(
                    20,
                    Math.max(0, Math.round(Number(v) || 0)),
                  ),
                }))
              }
            />
          </div>
          <div class="card">
            <p style={{ margin: 0 }}>
              Reading should return to the text itself, without breaking layout.
              <span
                style={{
                  display: "block",
                  opacity: styleCfg.opacity,
                  marginBlockStart: `${styleCfg.gapPx}px`,
                  borderInlineStart: `${styleCfg.strokePx}px solid currentColor`,
                  paddingInlineStart: `${styleCfg.insetPx}px`,
                }}
              >
                阅读应当回到文字本身，而不破坏原有页面排版。
              </span>
            </p>
          </div>
          <div class="actions">
            <Button onClick={() => setStyleCfg({ ...DEFAULT_STYLE })}>
              {en ? "Reset default style" : "恢复默认译文样式"}
            </Button>
          </div>
        </Disclosure>

        <div class="actions">
          <Button
            variant="primary"
            busy={store.isBusy("reading:save")}
            onClick={handleSaveReading}
          >
            {en ? "Save reading preferences" : "保存阅读设置"}
          </Button>
        </div>
      </fieldset>

      <fieldset>
        <legend>
          {en ? "Interface Appearance & Overlay" : "界面外观与进度浮层"}
        </legend>
        <div class="grid">
          <Select
            label={en ? "Color theme" : "外观主题"}
            value={theme}
            options={[
              { value: "system", label: en ? "Follow system" : "跟随系统" },
              { value: "light", label: en ? "Light" : "浅色" },
              { value: "dark", label: en ? "Dark" : "深色" },
            ]}
            onValueChange={(v) =>
              void handleImmediatePref({ nextTheme: v as Theme })
            }
          />
          <Select
            label={en ? "Interface language" : "设置页与浮层语言"}
            value={locale}
            options={[
              { value: "zh-CN", label: "简体中文" },
              { value: "en", label: "English" },
            ]}
            onValueChange={(v) =>
              void handleImmediatePref({ nextLocale: v as "zh-CN" | "en" })
            }
          />
        </div>
        <Switch
          checked={progressVisible}
          onChange={(v) => void handleImmediatePref({ nextVisible: v })}
          label={
            en
              ? "Show floating progress pill automatically while translating"
              : "翻译时默认显示右下角小进度条（关闭后仍会在出错时提示，或右键随时呼出）"
          }
        />
      </fieldset>

      <fieldset>
        <legend>{en ? "Per-Site Rules" : "网站专属规则"}</legend>
        <p class="hint">
          {en
            ? "Configure auto-translate, never-translate, main-article-only, or custom CSS skip selectors per origin."
            : "可按网站域名设置自动翻译、永不翻译、仅翻译正文（跳过导航侧栏页脚）或自定义跳过选择器。"}
        </p>

        <div class="grid">
          <TextInput
            label={en ? "Website URL or origin" : "网站地址"}
            type="url"
            placeholder="https://news.ycombinator.com"
            value={siteOrigin}
            onValueInput={(v) => setSiteOrigin(v)}
          />
          <Select
            label={en ? "Behavior" : "触发策略"}
            value={siteBehavior}
            options={[
              {
                value: "auto",
                label: en ? "Auto-translate on load" : "打开页面自动翻译",
              },
              {
                value: "never",
                label: en ? "Never auto-translate" : "从不自动翻译（黑名单）",
              },
              {
                value: "default",
                label: en
                  ? "Manual trigger with overrides"
                  : "手动触发（仅应用下方覆盖项）",
              },
            ]}
            onValueChange={(v) =>
              setSiteBehavior(v as NonNullable<SiteRule["mode"]>)
            }
          />
          <Select
            label={en ? "Display override" : "显示方式覆盖"}
            value={siteDisplay}
            options={[
              { value: "", label: en ? "Follow global" : "跟随全局默认" },
              { value: "chinese", label: en ? "Translated mode" : "译文模式" },
              { value: "bilingual", label: en ? "Bilingual" : "双语对照" },
            ]}
            onValueChange={(v) =>
              setSiteDisplay(v as "" | "chinese" | "bilingual")
            }
          />
          <Select
            label={en ? "Routing override" : "调用策略覆盖"}
            value={siteRouting}
            options={[
              { value: "", label: en ? "Follow global" : "跟随全局默认" },
              { value: "local-first", label: en ? "Local-first" : "本地优先" },
              { value: "local-only", label: en ? "Local-only" : "仅本地" },
              { value: "cloud-only", label: en ? "Cloud-only" : "仅云端" },
            ]}
            onValueChange={(v) =>
              setSiteRouting(
                v as "" | "local-first" | "local-only" | "cloud-only",
              )
            }
          />
          <TextInput
            label={
              en ? "Source language override" : "指定源语言（可选，如 en / ja）"
            }
            placeholder="auto"
            value={siteSourceLang}
            onValueInput={(v) => setSiteSourceLang(v)}
          />
          <TextInput
            label={
              en ? "Extra CSS skip selector" : "补充跳过选择器（CSS，可选）"
            }
            placeholder=".code-viewer, .math-inline"
            value={siteSkipSelector}
            onValueInput={(v) => setSiteSkipSelector(v)}
          />
        </div>

        <Switch
          checked={siteArticleOnly}
          onChange={(v) => setSiteArticleOnly(v)}
          label={
            en
              ? "Translate main article body only (skip nav, header, sidebar, footer)"
              : "只翻译正文区域（自动识别正文，跳过导航栏、侧边栏与页脚）"
          }
        />

        <div class="actions">
          <Button
            busy={store.isBusy("reading:site-save")}
            onClick={handleSaveSiteRule}
          >
            {en ? "Add / update site rule" : "添加或更新网站规则"}
          </Button>
          {lastRemovedSite ? (
            <Button
              variant="ghost"
              onClick={async () => {
                const snap = lastRemovedSite;
                setLastRemovedSite(null);
                await runTracedUiOp("undo-remove-site", async (t) => {
                  const rpc = scopedRpc(t);
                  await rpc.send("SAVE_SITE_RULE", snap);
                  onSavedConfig(await rpc.send<SettingsView>("PRIVATE"));
                });
                toast(
                  en
                    ? `Restored rule for ${snap.origin}.`
                    : `已撤销移除：${snap.origin}`,
                  "success",
                );
              }}
            >
              {en
                ? `Undo remove (${lastRemovedSite.origin})`
                : `撤销移除（${lastRemovedSite.origin}）`}
            </Button>
          ) : null}
        </div>

        <DataList
          items={siteEntries}
          getKey={([origin]) => origin}
          emptyMessage={
            en
              ? "No custom site rules yet. Add one above or toggle auto-translate from the page context menu."
              : "暂无网站专属规则。可在上方添加，或在网页右键菜单中直接开启「此网站自动翻译」。"
          }
          lang={lang}
          renderItem={([origin, rule]) => (
            <>
              <div class="list-row-main">
                <strong style={{ overflowWrap: "anywhere" }}>{origin}</strong>
                <p class="hint">
                  {[
                    rule.mode === "auto"
                      ? en
                        ? "Auto-translate"
                        : "自动翻译"
                      : rule.mode === "never"
                        ? en
                          ? "Never translate"
                          : "不自动翻译"
                        : en
                          ? "Manual + overrides"
                          : "手动触发（带覆盖）",
                    rule.display
                      ? rule.display === "bilingual"
                        ? en
                          ? "Bilingual"
                          : "双语"
                        : en
                          ? "Translated"
                          : "译文"
                      : "",
                    rule.routing || "",
                    rule.articleOnly ? (en ? "Article only" : "仅正文") : "",
                    rule.skipSelector
                      ? `${en ? "Skip" : "跳过"}: ${rule.skipSelector}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div class="actions">
                <Button
                  onClick={() => {
                    setSiteOrigin(origin);
                    setSiteBehavior(rule.mode || "default");
                    setSiteDisplay(rule.display || "");
                    setSiteRouting(rule.routing || "");
                    setSiteSourceLang(rule.sourceLang || "");
                    setSiteArticleOnly(Boolean(rule.articleOnly));
                    setSiteSkipSelector(rule.skipSelector || "");
                  }}
                >
                  {en ? "Edit" : "编辑"}
                </Button>
                <Button
                  variant="danger"
                  busy={store.isBusy(`site:remove:${origin}`)}
                  onClick={() => void handleRemoveSite(origin, rule)}
                >
                  {en ? "Remove" : "移除"}
                </Button>
              </div>
            </>
          )}
        />
      </fieldset>

      <fieldset>
        <legend>
          {en
            ? "Local Files, PDF Reader & Shortcuts"
            : "本地文件、PDF 阅读翻译与快捷键"}
        </legend>
        <p class="muted">
          {fileAccessAllowed
            ? en
              ? "File URL access is enabled. Local HTML/TXT files can be translated directly, and local PDFs can be opened in Qingyi's built-in offline PDF reader."
              : "已开启「允许访问文件网址」权限。本地 HTML/TXT 页面可直接右键翻译，PDF 文档可通过内置离线阅读器双语翻译。"
            : en
              ? "To translate local file:// pages directly, enable 'Allow access to file URLs' on Qingyi's extension details page. You can also open local PDFs right now in Qingyi's built-in offline PDF reader."
              : "若需直接翻译本地 file:// 网页，请在浏览器扩展详情页中开启「允许访问文件网址」。您也可以直接打开下方内置 PDF 离线阅读器选择本地 PDF 翻译。"}
        </p>
        <div class="actions">
          <Button
            onClick={() => {
              window.open(chrome.runtime.getURL("pdf.html"), "_blank");
            }}
          >
            {en ? "Open Built-in PDF Translator" : "打开内置 PDF 阅读翻译器"}
          </Button>
          {!fileAccessAllowed ? (
            <Button
              onClick={() => {
                void chrome.tabs.create({
                  url: `chrome://extensions/?id=${chrome.runtime.id}`,
                });
              }}
            >
              {en ? "Open Extension Permissions" : "前往扩展详情开启文件权限"}
            </Button>
          ) : null}
          <Button
            onClick={() => {
              void chrome.tabs.create({
                url: "chrome://extensions/shortcuts",
              });
            }}
          >
            {en ? "Customize Shortcuts" : "自定义浏览器快捷键"}
          </Button>
        </div>

        {commands.length > 0 ? (
          <div class="rows">
            {commands
              .filter((c) => c.name && c.name !== "_execute_action")
              .map((c) => (
                <div key={c.name} class="list-row">
                  <div class="list-row-main">
                    <strong>{c.description || c.name}</strong>
                    <span class="hint">
                      <code>{c.name}</code>
                    </span>
                  </div>
                  <Badge>{c.shortcut || (en ? "Unassigned" : "未绑定")}</Badge>
                </div>
              ))}
          </div>
        ) : null}
      </fieldset>
    </section>
  );
}
