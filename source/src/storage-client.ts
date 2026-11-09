import { CONFIG_KEY, DEFAULTS, type Trace } from "./types";
let creating: Promise<void> | undefined;
export async function ensureOffscreen() {
  await (creating ??= (async () => {
    if (!(await chrome.offscreen.hasDocument()))
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          "Own one SQLite OPFS database worker and buffered diagnostics across tabs.",
      });
    const data = await chrome.storage.local.get(CONFIG_KEY),
      budget = data[CONFIG_KEY]?.budgetBytes || DEFAULTS.budgetBytes;
    let last: unknown;
    for (let i = 0; i < 60; i++) {
      try {
        const ready = await chrome.runtime.sendMessage({
          target: "qingyi-offscreen",
          operation: "ready",
          budget,
        });
        if (ready?.ok) return;
        if (ready?.error) throw new Error(ready.error);
      } catch (e) {
        last = e;
        if (e instanceof Error && !e.message.includes("Receiving end")) throw e;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("OFFSCREEN_NOT_READY");
  })().catch((error) => {
    creating = undefined;
    throw error;
  }));
}
export async function storage(
  operation: string,
  args: unknown[] = [],
  trace?: Trace,
): Promise<any> {
  await ensureOffscreen();
  let result;
  const message = {
    target: "qingyi-offscreen",
    operation,
    args,
    trace,
  };
  try {
    result = await chrome.runtime.sendMessage(message);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("Receiving end")) throw e;
    creating = undefined;
    await ensureOffscreen();
    result = await chrome.runtime.sendMessage(message);
  }
  if (!result?.ok) throw new Error(result?.error || "STORAGE_UNAVAILABLE");
  return result.data;
}
export function record(
  trace: Trace,
  event: string,
  fields: Record<string, unknown> = {},
) {
  void ensureOffscreen()
    .then(() =>
      chrome.runtime.sendMessage({
        target: "qingyi-offscreen",
        operation: "trace.record",
        trace,
        event,
        fields,
      }),
    )
    .catch((e) => {
      if (e instanceof Error && e.message.includes("Receiving end"))
        creating = undefined;
    });
}
