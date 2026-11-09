const page = window as Window & { __qingyiShadowHook3?: boolean };
if (!page.__qingyiShadowHook3) {
  page.__qingyiShadowHook3 = true;
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (options: ShadowRootInit) {
    const root = Reflect.apply(original, this, [options]) as ShadowRoot;
    if (options.mode === "open")
      queueMicrotask(() =>
        this.dispatchEvent(
          new CustomEvent("qingyi-shadow-ready", {
            bubbles: true,
            composed: true,
          }),
        ),
      );
    return root;
  };
}
