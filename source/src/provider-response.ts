import { lines, streamBytes } from "./codec";
import { requireValue } from "./types";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderParseResult {
  text: string;
  usage?: TokenUsage;
}

function extractUsage(raw: any): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const prompt = Number(raw.prompt_tokens ?? raw.input_tokens);
  const completion = Number(raw.completion_tokens ?? raw.output_tokens);
  const total = Number(raw.total_tokens);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) {
    return undefined;
  }
  const p = Number.isFinite(prompt) ? Math.max(0, Math.floor(prompt)) : 0;
  const c = Number.isFinite(completion)
    ? Math.max(0, Math.floor(completion))
    : 0;
  return {
    promptTokens: p,
    completionTokens: c,
    totalTokens: Number.isFinite(total)
      ? Math.max(0, Math.floor(total))
      : p + c,
  };
}

export async function providerResult(
  response: Response,
  onFirst: () => void,
): Promise<ProviderParseResult> {
  requireValue(response.body, "EMPTY_RESPONSE");
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = JSON.parse(
      new TextDecoder().decode(
        await streamBytes(response.body, 2 * 1024 * 1024),
      ),
    );
    const choice = data.choices?.[0];
    requireValue(choice?.finish_reason !== "length", "TRANSLATION_TRUNCATED");
    requireValue(
      typeof choice?.message?.content === "string",
      "INVALID_PROVIDER_RESPONSE",
    );
    onFirst();
    return {
      text: choice.message.content as string,
      usage: extractUsage(data.usage),
    };
  }

  let text = "",
    size = 0,
    finished = false,
    first = true,
    usage: TokenUsage | undefined;

  try {
    for await (const line of lines(response.body, 256 * 1024)) {
      size += line.length;
      requireValue(size <= 2 * 1024 * 1024, "PROVIDER_RESPONSE_TOO_LARGE");
      if (!line.startsWith("data:")) continue;
      const value = line.slice(5).trim();
      if (value === "[DONE]") {
        finished = true;
        break;
      }
      const chunk = JSON.parse(value);
      requireValue(!chunk.error, "INVALID_PROVIDER_RESPONSE");
      const parsedUsage = extractUsage(chunk.usage);
      if (parsedUsage) usage = parsedUsage;
      const choice = chunk.choices?.[0];
      requireValue(choice?.finish_reason !== "length", "TRANSLATION_TRUNCATED");
      if (choice?.finish_reason === "stop") finished = true;
      if (typeof choice?.delta?.content === "string") {
        text += choice.delta.content;
        if (first && choice.delta.content) {
          first = false;
          onFirst();
        }
      }
    }
  } catch (err) {
    if (
      err instanceof Error &&
      [
        "PROVIDER_RESPONSE_TOO_LARGE",
        "TRANSLATION_TRUNCATED",
        "INVALID_PROVIDER_RESPONSE",
      ].includes(err.message)
    ) {
      throw err;
    }
    throw Object.assign(new Error("STREAM_INTERRUPTED"), {
      code: "STREAM_INTERRUPTED",
      partialText: text,
      usage,
    });
  }

  if (!finished) {
    throw Object.assign(new Error("STREAM_INTERRUPTED"), {
      code: "STREAM_INTERRUPTED",
      partialText: text,
      usage,
    });
  }
  requireValue(!!text, "INVALID_PROVIDER_RESPONSE");
  return { text, usage };
}

export async function providerText(
  response: Response,
  onFirst: () => void,
): Promise<string> {
  return (await providerResult(response, onFirst)).text;
}
