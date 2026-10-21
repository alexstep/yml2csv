import { describe, expect, test } from "bun:test";
import { formatCsvField, formatCsvRow, normalizeDelimiter, orderColumns } from "../src/csv.ts";
import { YmlError } from "../src/errors.ts";

describe("CSV RFC 4180", () => {
  test("простые поля не закавычиваются", () => {
    expect(formatCsvRow(["id", "Цена"], ",")).toBe("id,Цена");
  });

  test("кавычки удваиваются, перевод строки остаётся внутри поля", () => {
    const field = 'Описание с "кавычками" и\nпереносом, запятой';
    expect(formatCsvField(field, ",")).toBe('"Описание с ""кавычками"" и\nпереносом, запятой"');
  });

  test("точка с запятой тоже заставляет взять поле в кавычки", () => {
    expect(formatCsvField("a;b", ";")).toBe('"a;b"');
    expect(formatCsvField("a,b", ";")).toBe("a,b");
  });

  test("разделитель tab", () => {
    expect(normalizeDelimiter("tab")).toBe("\t");
    expect(normalizeDelimiter("\\t")).toBe("\t");
  });

  test("запрещённый разделитель", () => {
    expect(() => normalizeDelimiter("")).toThrow(YmlError);
    expect(() => normalizeDelimiter('"')).toThrow(YmlError);
  });

  test("param-колонки оказываются в конце, известные поля — в стабильном порядке", () => {
    expect(orderColumns(["description", "param:Цвет", "id", "price", "vendorCode"])).toEqual([
      "id",
      "price",
      "vendorCode",
      "description",
      "param:Цвет",
    ]);
  });
});
