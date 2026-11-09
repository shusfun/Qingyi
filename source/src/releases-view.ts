import type { ReleaseInfo } from "./releases";
export function renderRelease(container: HTMLElement, release: ReleaseInfo) {
  container.replaceChildren();
  const note = document.createElement("pre");
  note.textContent = `当前 ${release.current} / 最新 ${release.tag}\n${release.newer ? "发现新版本，可手动下载更新。" : "当前版本无需升级；也可下载匹配安装包。"}\n${release.notes}`;
  container.append(note);
  if (!release.assets.length) {
    const message = document.createElement("p");
    message.textContent = "此 Release 没有与版本号匹配的 Chromium 安装包。";
    container.append(message);
    return;
  }
  const hint = document.createElement("p");
  hint.textContent = release.hasChecksum
    ? "下载 ZIP 和 SHA-256，核对摘要后替换目录并重新加载。"
    : "此 Release 未提供 SHA-256 摘要，请从发布方获取摘要后核对。";
  container.append(hint);
  for (const asset of release.assets) {
    const link = document.createElement("a");
    link.textContent = "下载 " + asset.name;
    link.href = asset.url;
    link.download = asset.name;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = "download";
    container.append(link);
    if (asset.digest) {
      const digest = document.createElement("code");
      digest.textContent = asset.digest;
      container.append(digest);
    }
  }
}
