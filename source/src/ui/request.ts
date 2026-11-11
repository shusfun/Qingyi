import { childTrace, newTrace } from "../trace";
import type { Trace } from "../types";

export async function send(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = chrome.runtime.sendMessage({ type, ...payload });
    const result =
      type === "PRIVATE"
        ? await Promise.race([
            response,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(Error("后台未响应，请重新启用轻译后重试。")),
                10000,
              );
            }),
          ])
        : await response;
    if (!result?.ok) throw Error(result?.error || "EXTENSION_UNAVAILABLE");
    return result.data;
  } finally {
    clearTimeout(timer);
  }
}
export function record(
  trace: Trace,
  event: string,
  fields: Record<string, unknown> = {},
) {
  return send("TRACE", { trace, event, fields }).catch(() => undefined);
}
export function scoped(trace: Trace) {
  const request = (type: string, payload: Record<string, unknown> = {}) =>
    send(type, {
      ...payload,
      trace:
        type === "TRACE"
          ? payload.trace || trace
          : childTrace((payload.trace as Trace) || trace),
    });
  return {
    send: request,
    db: (operation: string, args: unknown[] = [], parent = trace) =>
      request("DATABASE", { operation, args, trace: parent }),
  };
}
export async function runOperation<T>(
  name: string,
  action: (trace: Trace) => Promise<T>,
  trace = newTrace(),
): Promise<T> {
  const start = performance.now();
  void record(trace, "ui.start", { outcome: "started", resourceId: name });
  try {
    const result = await action(trace);
    await record(trace, "ui.end", {
      outcome: "success",
      resourceId: name,
      durationMs: performance.now() - start,
    });
    return result;
  } catch (error) {
    await record(trace, "ui.end", {
      outcome:
        error instanceof Error && /CANCELLED$/.test(error.message)
          ? "cancelled"
          : "failed",
      resourceId: name,
      durationMs: performance.now() - start,
      reason:
        error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "UI_OPERATION_FAILED",
    });
    throw error;
  }
}
