import { describe, expect, test } from "bun:test";
import {
  decodeWindows1251,
  detectEncoding,
  encodeWindows1251,
  normalizeEncoding,
} from "../src/encoding.ts";
import { YmlError } from "../src/errors.ts";

describe("кодировки", () => {
  test("синонимы windows-1251", () => {
    expect(normalizeEncoding("CP1251")).toBe("windows-1251");
    expect(normalizeEncoding("win-1251")).toBe("windows-1251");
    expect(normalizeEncoding("utf8")).toBe("utf-8");
  });

  test("таблица windows-1251 совпадает с TextDecoder, если он есть", () => {
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder("windows-1251");
    } catch {
      return;
    }
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) bytes[i] = i;
    const ours = decodeWindows1251(bytes);
    const theirs = decoder.decode(bytes);
    expect(ours.length).toBe(256);
    for (let i = 0; i < 256; i += 1) {
      if (i === 0x98) continue;
      expect(ours[i]).toBe(theirs[i]);
    }
  });

  test("круговой проход кириллицы, кавычек и номера", () => {
    const text = "Ёлка №1 «тест»";
    expect(decodeWindows1251(encodeWindows1251(text))).toBe(text);
  });

  test("декларация windows-1251 и отказ от неизвестной кодировки", () => {
    const declared = new TextEncoder().encode('<?xml version="1.0" encoding="Windows-1251"?><a/>');
    expect(detectEncoding(declared, "auto")).toBe("windows-1251");
    const koi = new TextEncoder().encode('<?xml version="1.0" encoding="koi8-r"?><a/>');
    expect(() => detectEncoding(koi, "auto")).toThrow(YmlError);
    expect(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c]), "auto")).toBe("utf-8");
  });
});
