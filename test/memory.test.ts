import { expect, test } from "bun:test";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertYml } from "../src/index.ts";

async function* streamFile(path: string): AsyncGenerator<Uint8Array> {
  const file = Bun.file(path);
  const reader = file.stream().getReader();
  const target = 64 * 1024;
  let pending = new Uint8Array(0);
  const push = function* (bytes: Uint8Array): Generator<Uint8Array> {
    if (pending.byteLength === 0) pending = bytes;
    else {
      const merged = new Uint8Array(pending.byteLength + bytes.byteLength);
      merged.set(pending);
      merged.set(bytes, pending.byteLength);
      pending = merged;
    }
    while (pending.byteLength >= target) {
      yield pending.subarray(0, target);
      pending = pending.subarray(target);
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield* push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (pending.byteLength > 0) yield pending;
}

test("большой фид не удерживается в памяти целиком", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yml2csv-mem-"));
  const path = join(dir, "large.xml");
  const offers = 120_000;
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(path);
      out.on("error", reject);
      out.write(`<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="2024-01-01T00:00:00+03:00"><shop><categories><category id="1">Каталог</category></categories><offers>\n`);
      let index = 0;
      const writeSome = () => {
        let ok = true;
        while (index < offers && ok) {
          ok = out.write(
            `<offer id="p${index}" available="true"><url>https://example.com/p/${index}</url><price>${index}</price><currencyId>RUR</currencyId><categoryId>1</categoryId><picture>https://example.com/i/${index}.jpg</picture><name>Товар ${index} с достаточно длинным названием</name><description>Описание товара ${index} без сюрпризов для оценки памяти</description></offer>\n`,
          );
          index += 1;
        }
        if (index < offers) {
          out.once("drain", writeSome);
          return;
        }
        out.end("</offers></shop></yml_catalog>\n", () => resolve());
      };
      writeSome();
    });

    const size = (await stat(path)).size;
    expect(size).toBeGreaterThan(32 * 1024 * 1024);

    const baseline = process.memoryUsage().heapUsed;
    let peak = baseline;
    const timer = setInterval(() => {
      const used = process.memoryUsage().heapUsed;
      if (used > peak) peak = used;
    }, 30);
    let offersSeen = 0;
    const result = await convertYml(() => streamFile(path), {
      write() {
        offersSeen += 1;
      },
    });
    clearInterval(timer);
    Bun.gc(true);
    const retained = process.memoryUsage().heapUsed - baseline;
    const growth = peak - baseline;

    expect(result.offerCount).toBe(offers);
    expect(offersSeen).toBeGreaterThan(offers);
    expect(retained).toBeLessThan(16 * 1024 * 1024);
    expect(growth).toBeLessThan(size / 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 180_000);
