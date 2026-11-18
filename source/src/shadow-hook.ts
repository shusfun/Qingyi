const page = window as Window & { __qingyiShadowHook3?: boolean };
if (!page.__qingyiShadowHook3) {
  page.__qingyiShadowHook3 = true;
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (options: ShadowRootInit) {
    const root = Reflect.apply(original, this, [options]) as ShadowRoot;
    // Notify isolated-world content script for both open and closed shadow roots (Q-T16);
    // content.ts skips its own [data-qingyi] overlay host and reads closed roots via chrome.dom.openOrClosedShadowRoot.
    queueMicrotask(() => {
      if ((this as HTMLElement).dataset?.qingyi) return;
      this.dispatchEvent(
        new CustomEvent("qingyi-shadow-ready", {
          bubbles: true,
          composed: true,
        }),
      );
    });
    return root;
  };
}
