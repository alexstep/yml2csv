import { YmlError } from "./errors.js";

/** Кодировка входного фида. `auto` смотрит на BOM и XML-декларацию. */
export type EncodingChoice = "auto" | "utf-8" | "windows-1251";

export type EncodingName = "utf-8" | "windows-1251";

/**
 * Символы windows-1251 для байтов 0x80–0xFF.
 * 0x98 в этой кодировке не определён — заменяется на U+FFFD.
 */
const CP1251_HIGH = [
  0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac, 0x2030, 0x0409, 0x2039, 0x040a,
  0x040c, 0x040b, 0x040f, 0x0452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0xfffd, 0x2122,
  0x0459, 0x203a, 0x045a, 0x045c, 0x045b, 0x045f, 0x00a0, 0x040e, 0x045e, 0x0408, 0x00a4, 0x0490, 0x00a6,
  0x00a7, 0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x0407, 0x00b0, 0x00b1, 0x0406, 0x0456,
  0x0491, 0x00b5, 0x00b6, 0x00b7, 0x0451, 0x2116, 0x0454, 0x00bb, 0x0458, 0x0405, 0x0455, 0x0457,
];
// Байты 0xC0–0xFF — непрерывный блок А…я.
for (let code = 0x0410; code <= 0x044f; code += 1) CP1251_HIGH.push(code);
if (CP1251_HIGH.length !== 128) {
  throw new Error(`Таблица windows-1251 собрана неверно: ${CP1251_HIGH.length}`);
}

const CP1251_CHARS = CP1251_HIGH.map((code) => String.fromCharCode(code)).join("");

const CP1251_BYTE = new Map<number, number>();
for (let i = 0; i < CP1251_HIGH.length; i += 1) {
  const code = CP1251_HIGH[i]!;
  if (code !== 0xfffd) CP1251_BYTE.set(code, 0x80 + i);
}

export function normalizeEncoding(value: string | undefined): EncodingChoice {
  const raw = (value ?? "auto").trim().toLowerCase().replace(/_/g, "-");
  if (raw === "auto" || raw === "") return "auto";
  if (raw === "utf-8" || raw === "utf8") return "utf-8";
  const flat = raw.replace(/-/g, "");
  if (flat === "windows1251" || flat === "cp1251" || flat === "win1251") return "windows-1251";
  throw new YmlError(`Неизвестная кодировка «${value}». Допустимы auto, utf-8 и windows-1251.`);
}

export function decodeWindows1251(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]!;
    out += byte < 0x80 ? String.fromCharCode(byte) : (CP1251_CHARS[byte - 0x80] ?? "\uFFFD");
  }
  return out;
}

/** Кодирует строку в windows-1251. Нужен CLI-тестам и проверке кругового прохода. */
export function encodeWindows1251(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out[i] = code;
      continue;
    }
    const byte = CP1251_BYTE.get(code);
    if (byte === undefined) {
      throw new YmlError(`Символ U+${code.toString(16)} нельзя записать в windows-1251.`);
    }
    out[i] = byte;
  }
  return out;
}

export function detectEncoding(bytes: Uint8Array, choice: EncodingChoice): EncodingName {
  if (bytes.length >= 2) {
    const utf16le = bytes[0] === 0xff && bytes[1] === 0xfe;
    const utf16be = bytes[0] === 0xfe && bytes[1] === 0xff;
    if (utf16le || utf16be) {
      throw new YmlError("UTF-16 не поддерживается. Сохраните фид в UTF-8 или windows-1251.");
    }
  }
  if (choice === "utf-8") return "utf-8";
  if (choice === "windows-1251") return "windows-1251";

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";

  const sampleLength = Math.min(bytes.length, 400);
  let sample = "";
  for (let i = 0; i < sampleLength; i += 1) sample += String.fromCharCode(bytes[i]!);
  const declared = sample.match(/encoding\s*=\s*["']([^"']+)["']/i);
  if (!declared) return "utf-8";
  const name = declared[1]!.trim();
  try {
    const normalized = normalizeEncoding(name);
    if (normalized === "auto") return "utf-8";
    return normalized;
  } catch {
    throw new YmlError(
      `Кодировка «${name}» из XML-декларации не поддерживается. Используйте UTF-8 или windows-1251.`,
    );
  }
}

export function createDecoder(encoding: EncodingName): (chunk: Uint8Array, final: boolean) => string {
  if (encoding === "windows-1251") {
    return (chunk) => decodeWindows1251(chunk);
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return (chunk, final) => decoder.decode(chunk, { stream: !final });
}

export function stripUtf8Bom(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3);
  }
  return bytes;
}
