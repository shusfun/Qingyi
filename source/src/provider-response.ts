import { lines, streamBytes } from "./codec";
import { requireValue } from "./types";
export async function providerText(response: Response, onFirst: () => void) {
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
    return choice.message.content as string;
  }
  let text = "",
    size = 0,
    finished = false,
    first = true;
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
  requireValue(finished && text, "INVALID_PROVIDER_RESPONSE");
  return text;
}
