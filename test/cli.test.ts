import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWindows1251 } from "../src/encoding.ts";
import { parseCliArgs } from "../src/cli.ts";
import { rowsByHeader } from "./support.ts";

const shopPath = new URL("../examples/shop.xml", import.meta.url).pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

async function run(args: string[], stdin?: Uint8Array) {
  const proc = Bun.spawn(["bun", cli, ...args], {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("CLI", () => {
  test("разбор аргументов, в том числе --excel после --no-bom", () => {
    expect(parseCliArgs(["feed.xml", "-o", "out.csv", "-d", ";", "--bom", "-c", "id, name ,price"])).toMatchObject({
      input: "feed.xml",
      output: "out.csv",
      delimiter: ";",
      bom: true,
      columns: ["id", "name", "price"],
    });
    expect(parseCliArgs(["--no-bom", "--excel"]).bom).toBe(true);
    expect(parseCliArgs(["--excel", "--delimiter", ","])).toMatchObject({ delimiter: ",", bom: true });
    expect(() => parseCliArgs(["--nope"])).toThrow(/Неизвестный/);
  });

  test("файл в stdout и сводка в stderr", async () => {
    const { stdout, stderr, code } = await run([shopPath, "-q"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const rows = rowsByHeader(stdout);
    expect(rows).toHaveLength(6);
    expect(rows[0]?.id).toBe("A1");
    expect(stdout.startsWith("id,")).toBe(true);
  });

  test("--excel пишет BOM и точку с запятой, --columns режет набор", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yml2csv-cli-"));
    const output = join(dir, "out.csv");
    try {
      const { code, stderr } = await run([shopPath, "-o", output, "--excel", "-c", "id,name,category", "-q"]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      const bytes = new Uint8Array(await readFile(output));
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(bytes);
      const rows = rowsByHeader(text, ";");
      expect(Object.keys(rows[0] ?? {})).toEqual(["id", "name", "category"]);
      expect(rows[0]?.category).toBe("Электроника > Телефоны > Смартфоны");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stdin, отсутствующий файл и URL", async () => {
    const xml = `<?xml version="1.0"?><yml_catalog><shop><categories><category id="1">Книги</category></categories><offers><offer id="Z" available="true"><price>3</price><categoryId>1</categoryId><name>Из stdin</name></offer></offers></shop></yml_catalog>`;
    const fromStdin = await run(["-"], new TextEncoder().encode(xml));
    expect(fromStdin.code).toBe(0);
    expect(rowsByHeader(fromStdin.stdout)[0]?.name).toBe("Из stdin");

    const missing = await run(["/tmp/yml2csv-no-such-file.xml"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Файл не найден");

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
      },
    });
    try {
      const fromUrl = await run([`http://127.0.0.1:${server.port}/feed.xml`, "-q"]);
      expect(fromUrl.code).toBe(0);
      expect(rowsByHeader(fromUrl.stdout)[0]?.id).toBe("Z");
    } finally {
      server.stop(true);
    }
  });

  test("принудительная кодировка windows-1251", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yml2csv-1251-"));
    const input = join(dir, "feed.xml");
    const xml = `<?xml version="1.0" encoding="windows-1251"?><yml_catalog><shop><categories><category id="1">Ёлки</category></categories><offers><offer id="1"><price>1</price><categoryId>1</categoryId><name>Ёлка</name></offer></offers></shop></yml_catalog>`;
    await writeFile(input, encodeWindows1251(xml));
    try {
      const { stdout, code } = await run([input, "-e", "cp1251", "-q"]);
      expect(code).toBe(0);
      expect(rowsByHeader(stdout)[0]?.name).toBe("Ёлка");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
