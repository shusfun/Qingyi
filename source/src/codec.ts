import { encoder, decoder, requireValue } from "./types";
export function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
export function unbase64(value: string, limit = 2 * 1024 * 1024) {
  requireValue(
    typeof value === "string" && value.length <= limit * 1.4,
    "BLOCK_TOO_LARGE",
  );
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export async function streamBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
) {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      requireValue(total <= limit, "DECOMPRESS_LIMIT");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
export async function compress(raw: Uint8Array) {
  if (raw.length < 512) return { codec: 0, data: raw };
  const bytes = await streamBytes(
    new Blob([raw as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream("gzip")),
    raw.length + 1024,
  );
  return bytes.length + 128 < raw.length * 0.9
    ? { codec: 1, data: bytes }
    : { codec: 0, data: raw };
}
export async function decompress(
  data: Uint8Array,
  codec: number,
  limit = 1024 * 1024,
) {
  if (!codec) {
    requireValue(data.length <= limit, "BLOCK_TOO_LARGE");
    return data;
  }
  requireValue(codec === 1, "INVALID_CODEC");
  return streamBytes(
    new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip")),
    limit,
  );
}
export async function* lines(
  stream: ReadableStream<Uint8Array>,
  maxLine = 3 * 1024 * 1024,
) {
  const reader = stream.getReader();
  let tail = "";
  const td = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        tail += td.decode();
        break;
      }
      tail += td.decode(value, { stream: true });
      let p;
      while ((p = tail.indexOf("\n")) >= 0) {
        requireValue(p <= maxLine, "LINE_TOO_LARGE");
        const line = tail.slice(0, p).trim();
        tail = tail.slice(p + 1);
        if (line) yield line;
      }
      requireValue(tail.length <= maxLine, "LINE_TOO_LARGE");
    }
    if (tail.trim()) yield tail.trim();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function encodeLines(values: unknown[]) {
  return encoder.encode(values.map((v) => JSON.stringify(v)).join("\n") + "\n");
}
export const decodeLines = (bytes: Uint8Array) =>
  decoder
    .decode(bytes)
    .split("\n")
    .filter((s) => s.trim())
    .map((s) => JSON.parse(s));
