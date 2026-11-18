import { useEffect, useState } from "preact/hooks";
import {
  Badge,
  Button,
  DataList,
  Disclosure,
  FeedbackBanner,
  IconExternalLink,
  IconFileText,
  IconPlus,
  IconTrash,
  SegmentedControl,
  Select,
  SettingGroup,
  SettingRow,
  Switch,
  Slider,
  TextInput,
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
          theme,
          visible: progressVisible,
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
      <FeedbackBanner scope="reading" lang={lang} />

      <SettingGroup
        title={en ? "Translation & Display" : "翻译语言与展示方式"}
        actions={
          <Button
            size="sm"
            variant="primary"
            busy={store.isBusy("reading:save")}
            onClick={handleSaveReading}
          >
            {en ? "Save Preferences" : "保存阅读设置"}
          </Button>
        }
      >
        <SettingRow
          title={en ? "Default target language" : "默认目标语言"}
          controlWidth="medium"
        >
          <Select
            value={targetLang}
            options={targetLangOptions}
            onValueChange={(v) => setTargetLang(v)}
          />
        </SettingRow>

        <SettingRow
          title={en ? "Reading mode" : "网页显示模式"}
          description={
            mode === "bilingual"
              ? en
                ? "Inserts translation inside original blocks without breaking tables or flex layouts."
                : "在原段落内嵌显示译文，不破坏表格与布局。"
              : en
                ? "Replaces paragraph text cleanly in-place."
                : "直接原位替换为译文。"
          }
        >
          <SegmentedControl
            value={mode}
            onChange={(v) => setMode(v)}
            options={[
              { value: "chinese", label: en ? "Translated" : "仅译文" },
              { value: "bilingual", label: en ? "Bilingual" : "双语对照" },
            ]}
          />
        </SettingRow>

        <SettingRow
          title={en ? "Translate UI attributes" : "翻译输入框提示与无障碍属性"}
          description={
            en
              ? "Includes placeholder, title, alt, and aria-label"
              : "包含 placeholder、title、alt 与 aria-label"
          }
        >
          <Switch
            checked={translateAttributes}
            onChange={(v) => setTranslateAttributes(v)}
          />
        </SettingRow>
      </SettingGroup>

      <Disclosure
        summary={
          en ? "Bilingual Typography & Live Preview" : "双语对照排版微调与预览"
        }
      >
        <div class="grid">
          <Slider
            label={en ? "Opacity" : "译文不透明度"}
            min={0.5}
            max={1}
            step={0.02}
            value={styleCfg.opacity}
            onValueInput={(value) =>
              setStyleCfg((current) => ({ ...current, opacity: value }))
            }
          />
          <Slider
            label={en ? "Spacing" : "上下间距"}
            min={0}
            max={16}
            step={1}
            unit="px"
            value={styleCfg.gapPx}
            onValueInput={(value) =>
              setStyleCfg((current) => ({ ...current, gapPx: value }))
            }
          />
          <Slider
            label={en ? "Bar width" : "引线粗细"}
            min={0}
            max={6}
            step={1}
            unit="px"
            value={styleCfg.strokePx}
            onValueInput={(value) =>
              setStyleCfg((current) => ({ ...current, strokePx: value }))
            }
          />
          <Slider
            label={en ? "Left inset" : "左侧缩进"}
            min={0}
            max={20}
            step={1}
            unit="px"
            value={styleCfg.insetPx}
            onValueInput={(value) =>
              setStyleCfg((current) => ({ ...current, insetPx: value }))
            }
          />
        </div>
        <div class="copy-box" style={{ marginTop: "10px", display: "block" }}>
          <p style={{ margin: 0, fontSize: "var(--font-sm)" }}>
            Clear, fast, local-first web translation without page clutter.
            <span
              style={{
                display: "block",
                opacity: styleCfg.opacity,
                marginBlockStart: `${styleCfg.gapPx}px`,
                borderInlineStart: `${styleCfg.strokePx}px solid var(--color-accent)`,
                paddingInlineStart: `${styleCfg.insetPx}px`,
              }}
            >
              清晰、快速、本地优先的网页翻译，不打扰原有页面排版。
            </span>
          </p>
        </div>
        <div class="actions" style={{ marginBottom: 0 }}>
          <Button size="sm" onClick={() => setStyleCfg({ ...DEFAULT_STYLE })}>
            {en ? "Reset Style" : "恢复默认样式"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            busy={store.isBusy("reading:save")}
            onClick={handleSaveReading}
          >
            {en ? "Apply Style" : "保存样式"}
          </Button>
        </div>
      </Disclosure>

      <SettingGroup title={en ? "Appearance & Progress Bar" : "外观与进度条"}>
        <SettingRow title={en ? "Theme" : "外观主题"}>
          <SegmentedControl
            value={theme}
            onChange={(v) => void handleImmediatePref({ nextTheme: v })}
            options={[
              { value: "system", label: en ? "System" : "跟随系统" },
              { value: "light", label: en ? "Light" : "浅色" },
              { value: "dark", label: en ? "Dark" : "深色" },
            ]}
          />
        </SettingRow>

        <SettingRow title={en ? "Interface language" : "界面语言"}>
          <SegmentedControl
            value={locale}
            onChange={(v) => void handleImmediatePref({ nextLocale: v })}
            options={[
              { value: "zh-CN", label: "简体中文" },
              { value: "en", label: "English" },
            ]}
          />
        </SettingRow>

        <SettingRow
          title={
            en
              ? "Show progress pill while translating"
              : "翻译时显示右下角小进度条"
          }
          description={
            en
              ? "Only mounts during active translation; errors always surface."
              : "仅在激活翻译时挂载，关闭后仍可通过右键菜单随时查看。"
          }
        >
          <Switch
            checked={progressVisible}
            onChange={(v) => void handleImmediatePref({ nextVisible: v })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title={en ? "PDF Reader & Shortcuts" : "内置 PDF 阅读器与快捷键"}
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              icon={<IconFileText size={14} />}
              onClick={() => {
                window.open(chrome.runtime.getURL("pdf.html"), "_blank");
              }}
            >
              {en ? "Open PDF Translator" : "打开 PDF 翻译器"}
            </Button>
            <Button
              size="sm"
              icon={<IconExternalLink size={13} />}
              onClick={() => {
                void chrome.tabs.create({
                  url: "chrome://extensions/shortcuts",
                });
              }}
            >
              {en ? "Shortcuts" : "修改快捷键"}
            </Button>
          </>
        }
      >
        <SettingRow
          title={en ? "Local file:// URL access" : "本地 file:// 网页访问权限"}
          description={
            fileAccessAllowed
              ? en
                ? "Enabled in browser extension settings."
                : "已在浏览器扩展详情中开启。"
              : en
                ? "Enable 'Allow access to file URLs' to translate local HTML files."
                : "如需直接右键翻译本地 HTML 文件，请在扩展详情页开启「允许访问文件网址」。"
          }
        >
          {fileAccessAllowed ? (
            <Badge tone="success">{en ? "Enabled" : "已开启"}</Badge>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                void chrome.tabs.create({
                  url: `chrome://extensions/?id=${chrome.runtime.id}`,
                });
              }}
            >
              {en ? "Enable…" : "去开启…"}
            </Button>
          )}
        </SettingRow>

        {commands
          .filter((c) => c.name && c.name !== "_execute_action")
          .map((c) => (
            <SettingRow key={c.name} title={c.description || c.name}>
              <Badge>{c.shortcut || (en ? "Unassigned" : "未绑定")}</Badge>
            </SettingRow>
          ))}
      </SettingGroup>

      <SettingGroup
        title={en ? "Per-Site Rules" : "网站专属规则"}
        padded
        actions={
          lastRemovedSite ? (
            <Button
              size="sm"
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
                  en ? `Restored ${snap.origin}.` : `已恢复 ${snap.origin}`,
                  "success",
                );
              }}
            >
              {en ? "Undo remove" : `撤销移除（${lastRemovedSite.origin}）`}
            </Button>
          ) : null
        }
      >
        <div class="grid">
          <TextInput
            label={en ? "Website URL" : "网站域名或地址"}
            type="url"
            placeholder="https://news.ycombinator.com"
            value={siteOrigin}
            onValueInput={(v) => setSiteOrigin(v)}
          />
          <Select
            label={en ? "Behavior" : "触发行为"}
            value={siteBehavior}
            options={[
              { value: "auto", label: en ? "Auto-translate" : "打开自动翻译" },
              {
                value: "never",
                label: en ? "Never translate" : "永不自动翻译",
              },
              {
                value: "default",
                label: en ? "Manual + overrides" : "手动触发（仅覆盖参数）",
              },
            ]}
            onValueChange={(v) =>
              setSiteBehavior(v as NonNullable<SiteRule["mode"]>)
            }
          />
          <Select
            label={en ? "Display" : "显示方式"}
            value={siteDisplay}
            options={[
              { value: "", label: en ? "Global default" : "跟随全局" },
              { value: "chinese", label: en ? "Translated" : "仅译文" },
              { value: "bilingual", label: en ? "Bilingual" : "双语对照" },
            ]}
            onValueChange={(v) =>
              setSiteDisplay(v as "" | "chinese" | "bilingual")
            }
          />
          <Select
            label={en ? "Routing" : "调用策略"}
            value={siteRouting}
            options={[
              { value: "", label: en ? "Global default" : "跟随全局" },
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
            label={en ? "Source language" : "指定源语言（可选）"}
            placeholder="auto"
            value={siteSourceLang}
            onValueInput={(v) => setSiteSourceLang(v)}
          />
          <TextInput
            label={en ? "Skip CSS selector" : "跳过选择器（可选）"}
            placeholder=".code-viewer, .math"
            value={siteSkipSelector}
            onValueInput={(v) => setSiteSkipSelector(v)}
          />
        </div>

        <Switch
          checked={siteArticleOnly}
          onChange={(v) => setSiteArticleOnly(v)}
          label={
            en ? "Main article body only" : "仅翻译正文（跳过导航、侧栏与页脚）"
          }
        />

        <div class="actions" style={{ marginBottom: "12px" }}>
          <Button
            icon={<IconPlus size={14} />}
            busy={store.isBusy("reading:site-save")}
            onClick={handleSaveSiteRule}
          >
            {en ? "Save Site Rule" : "保存网站规则"}
          </Button>
        </div>

        <DataList
          items={siteEntries}
          getKey={([origin]) => origin}
          emptyMessage={
            en
              ? "No custom site rules yet."
              : "暂无网站专属规则，可在上方添加或在网页右键菜单直接设置。"
          }
          lang={lang}
          renderItem={([origin, rule]) => (
            <>
              <div class="list-row-main">
                <strong>{origin}</strong>
                <p class="hint">
                  {[
                    rule.mode === "auto"
                      ? en
                        ? "Auto"
                        : "自动翻译"
                      : rule.mode === "never"
                        ? en
                          ? "Never"
                          : "不自动翻译"
                        : en
                          ? "Manual"
                          : "手动",
                    rule.display === "bilingual"
                      ? en
                        ? "Bilingual"
                        : "双语"
                      : rule.display === "chinese"
                        ? en
                          ? "Translated"
                          : "仅译文"
                        : "",
                    rule.routing || "",
                    rule.articleOnly ? (en ? "Article only" : "仅正文") : "",
                    rule.skipSelector ? `Skip: ${rule.skipSelector}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div class="actions" style={{ margin: 0 }}>
                <Button
                  size="sm"
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
                  size="sm"
                  variant="danger"
                  icon={<IconTrash size={13} />}
                  busy={store.isBusy(`site:remove:${origin}`)}
                  onClick={() => void handleRemoveSite(origin, rule)}
                >
                  {en ? "Remove" : "移除"}
                </Button>
              </div>
            </>
          )}
        />
      </SettingGroup>
    </section>
  );
}
