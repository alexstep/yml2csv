import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { convertYml, convertYmlText, YmlError } from "../src/index.ts";
import { encodeWindows1251 } from "../src/encoding.ts";
import { chunked, rowsByHeader } from "./support.ts";

const shop = readFileSync(new URL("../examples/shop.xml", import.meta.url), "utf8");

describe("конвертация YML", () => {
  test("пример фида: пути категорий, param, картинки и типы офферов", async () => {
    const result = await convertYmlText(shop);
    expect(result.offerCount).toBe(6);
    const rows = rowsByHeader(result.csv ?? "");
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

    expect(byId.A1?.category).toBe("Электроника > Телефоны > Смартфоны");
    expect(byId.A1?.picture).toBe("https://example.com/a1-1.jpg|https://example.com/a1-2.jpg");
    expect(byId.A1?.["param:Цвет"]).toBe("чёрный");
    expect(byId.A1?.["param:Память [ГБ]"]).toBe("128");
    expect(byId.A1?.barcode).toBe("111|222");
    expect(byId.A1?.price).toBe("19990");
    expect(byId.A1?.name).toBe("Телефон Проба");
    expect(byId.A1?.delivery_options ?? "").toBe("");

    expect(byId.B2?.type).toBe("vendor.model");
    expect(byId.B2?.available).toBe("false");
    expect(byId.B2?.group_id).toBe("g1");
    expect(byId.B2?.price).toBe("500");
    expect(byId.B2?.price_from).toBe("true");
    expect(byId.B2?.picture).toBe("https://example.com/b2.jpg");
    expect(byId.B2?.model).toBe("Model X");
    expect(byId.B2?.category).toBe("Электроника");
    expect(byId.B2?.description).toBe('Описание с "кавычками" и\nпереносом, запятой, и ; точкой с запятой.');

    expect(byId.C3?.type).toBe("book");
    expect(byId.C3?.author).toBe("Толстой");
    expect(byId.C3?.ISBN).toBe("978-5-00-000000-0");
    expect(byId.C3?.category).toBe("Книги");

    expect(byId.D4?.type).toBe("tour");
    expect(byId.D4?.date).toBe("2024-07-01|2024-07-15");
    expect(byId.D4?.country).toBe("Россия");
    expect(byId.D4?.category).toBe("Туры");

    expect(byId.E5?.delivery_options).toBe("cost=300;days=1;order-before=18|cost=0;days=3");
    expect(byId.E5?.pickup_options).toBe("cost=0;days=2");
    expect(byId.E5?.outlets).toBe("id=10;instock=4");
    expect(byId.E5?.age).toBe("18");
    expect(byId.E5?.age_unit).toBe("year");
    expect(byId.E5?.condition).toBe("preowned");
    expect(byId.E5?.condition_quality).toBe("excellent");
    expect(byId.E5?.condition_reason).toBe("царапина на корпусе");
    expect(byId.E5?.category).toBe("Электроника > Телефоны");
    expect(byId.E5?.collectionId).toBe("7|8");
    expect(byId.E5?.video).toBe("https://example.com/e5.mp4");

    expect(byId.F6?.type).toBe("event-ticket");
    expect(byId.F6?.place).toBe("Театр");
    expect(byId.F6?.date).toBe("2024-08-01 19:00");
    expect(byId.F6?.category).toBe("Билеты");

    expect(result.columns.at(-2)).toBe("param:Цвет");
    expect(result.columns.at(-1)).toBe("param:Память [ГБ]");
    expect(result.preview[0]).toEqual(result.columns);
    expect(result.preview.length).toBe(7);
  });

  test("кавычки и перевод строки экранируются, BOM и точка с запятой — опция", async () => {
    const excel = await convertYmlText(shop, { delimiter: ";", bom: true });
    expect(excel.csv?.charCodeAt(0)).toBe(0xfeff);
    const rows = rowsByHeader(excel.csv ?? "", ";");
    expect(rows[1]?.description).toBe('Описание с "кавычками" и\nпереносом, запятой, и ; точкой с запятой.');
    expect(excel.csv).toContain('"Описание с ""кавычками"" и\nпереносом, запятой, и ; точкой с запятой."');
  });

  test("выбор колонок сохраняет порядок и пустые ячейки", async () => {
    const result = await convertYmlText(shop, { columns: ["name", "id", "missing", "category"] });
    expect(result.columns).toEqual(["name", "id", "missing", "category"]);
    const rows = rowsByHeader(result.csv ?? "");
    expect(rows[0]).toEqual({
      name: "Телефон Проба",
      id: "A1",
      missing: "",
      category: "Электроника > Телефоны > Смартфоны",
    });
  });

  test("CDATA, сущности и единственный offer", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<yml_catalog date="2024-01-01T00:00:00+03:00">
  <shop>
    <categories><category id="1">Книги</category></categories>
    <offers>
      <offer id="ONLY" available="true">
        <price>10</price>
        <currencyId>RUR</currencyId>
        <categoryId>1</categoryId>
        <name>Один &amp; &quot;два&quot;</name>
        <description><![CDATA[A & B <tag> "q"]]></description>
      </offer>
    </offers>
  </shop>
</yml_catalog>`;
    const result = await convertYmlText(xml);
    const row = rowsByHeader(result.csv ?? "")[0];
    expect(result.offerCount).toBe(1);
    expect(row?.id).toBe("ONLY");
    expect(row?.name).toBe('Один & "два"');
    expect(row?.description).toBe('A & B <tag> "q"');
    expect(row?.category).toBe("Книги");
  });

  test("категория, которая в файле идёт после offers", async () => {
    const xml = `<?xml version="1.0"?>
<yml_catalog><shop>
  <offers><offer id="1" available="true"><price>5</price><categoryId>9</categoryId><name>Позже</name></offer></offers>
  <categories><category id="2">Корень</category><category id="9" parentId="2">Лист</category></categories>
</shop></yml_catalog>`;
    const row = rowsByHeader((await convertYmlText(xml)).csv ?? "")[0];
    expect(row?.category).toBe("Корень > Лист");
  });

  test("цикл в parentId не зацикливает путь", async () => {
    const xml = `<?xml version="1.0"?>
<yml_catalog><shop>
  <categories>
    <category id="1" parentId="2">А</category>
    <category id="2" parentId="1">Б</category>
  </categories>
  <offers><offer id="1"><categoryId>1</categoryId><name>X</name><price>1</price></offer></offers>
</shop></yml_catalog>`;
    const row = rowsByHeader((await convertYmlText(xml)).csv ?? "")[0];
    expect(row?.category === "Б > А" || row?.category === "А > Б").toBe(true);
    expect(row?.category?.includes("А")).toBe(true);
  });

  test("побайтовая нарезка UTF-8 не ломает теги и кириллицу", async () => {
    const whole = await convertYmlText(shop);
    const bytes = new TextEncoder().encode(shop);
    const sliced = await convertYml(() => chunked(bytes, 1));
    expect(sliced.csv).toBe(whole.csv);
    expect(sliced.offerCount).toBe(whole.offerCount);
  });

  test("windows-1251 определяется по декларации и читается побайтно", async () => {
    const xml = `<?xml version="1.0" encoding="windows-1251"?>
<yml_catalog><shop>
  <categories><category id="1">Ёлки</category></categories>
  <offers>
    <offer id="1" available="true">
      <price>15</price>
      <currencyId>RUR</currencyId>
      <categoryId>1</categoryId>
      <name>Ёлка №1 «тест»</name>
    </offer>
  </offers>
</shop></yml_catalog>`;
    const bytes = encodeWindows1251(xml);
    const whole = await convertYml(() => [bytes]);
    const sliced = await convertYml(() => chunked(bytes, 3), { encoding: "windows-1251" });
    const row = rowsByHeader(whole.csv ?? "")[0];
    expect(row?.name).toBe("Ёлка №1 «тест»");
    expect(row?.category).toBe("Ёлки");
    expect(sliced.csv).toBe(whole.csv);
  });

  test("пустой каталог и битый XML", async () => {
    const empty = await convertYmlText(`<?xml version="1.0"?><yml_catalog><shop><offers></offers></shop></yml_catalog>`);
    expect(empty.offerCount).toBe(0);
    expect(empty.csv).toBe("");
    expect(convertYmlText("")).rejects.toThrow(YmlError);
    expect(convertYmlText("<yml_catalog><shop></yml_catalog>")).rejects.toThrow(/XML/);
  });
});
