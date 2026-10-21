import { YmlError } from "./errors.js";

/** Порядок колонок, близкий к спецификации YML. Остальные поля идут после, param — в конце. */
export const PREFERRED_COLUMNS = [
  "id",
  "type",
  "available",
  "group_id",
  "bid",
  "cbid",
  "fee",
  "url",
  "price",
  "price_from",
  "oldprice",
  "oldprice_from",
  "currencyId",
  "categoryId",
  "category",
  "picture",
  "name",
  "typePrefix",
  "vendor",
  "vendorCode",
  "model",
  "description",
  "sales_notes",
  "manufacturer_warranty",
  "country_of_origin",
  "barcode",
  "weight",
  "dimensions",
  "store",
  "pickup",
  "delivery",
  "downloadable",
  "adult",
  "age",
  "age_unit",
  "expiry",
  "author",
  "publisher",
  "series",
  "year",
  "ISBN",
  "volume",
  "part",
  "language",
  "binding",
  "page_extent",
  "performed_by",
  "performance_type",
  "storage",
  "format",
  "recording_length",
  "artist",
  "title",
  "media",
  "starring",
  "worldRegion",
  "country",
  "region",
  "days",
  "dataTour",
  "date",
  "hotel_stars",
  "room",
  "meal",
  "included",
  "transport",
  "place",
  "hall",
  "hall_part",
  "is_premiere",
  "is_kids",
  "delivery_options",
  "pickup_options",
  "outlets",
  "condition",
  "condition_quality",
  "condition_reason",
  "collectionId",
  "video",
] as const;

export function normalizeDelimiter(value: string | undefined): string {
  const raw = value ?? ",";
  if (raw === "\\t" || raw.toLowerCase() === "tab") return "\t";
  const chars = Array.from(raw);
  if (chars.length !== 1) throw new YmlError("Разделитель CSV должен быть одним символом.");
  const delimiter = chars[0]!;
  if (delimiter === '"' || delimiter === "\n" || delimiter === "\r") {
    throw new YmlError("Кавычка и перевод строки не могут быть разделителем CSV.");
  }
  return delimiter;
}

/** Экранирование поля по RFC 4180. Кавычки удваиваются, перевод строки остаётся внутри кавычек. */
export function formatCsvField(value: string, delimiter: string): string {
  if (value.includes('"') || value.includes(delimiter) || value.includes("\n") || value.includes("\r")) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function formatCsvRow(fields: readonly string[], delimiter: string): string {
  return fields.map((field) => formatCsvField(field, delimiter)).join(delimiter);
}

export function orderColumns(seen: readonly string[]): string[] {
  const seenSet = new Set(seen);
  const used = new Set<string>();
  const result: string[] = [];
  for (const column of PREFERRED_COLUMNS) {
    if (!seenSet.has(column)) continue;
    result.push(column);
    used.add(column);
  }
  const params: string[] = [];
  for (const column of seen) {
    if (used.has(column)) continue;
    if (column.startsWith("param:")) params.push(column);
    else {
      result.push(column);
      used.add(column);
    }
  }
  result.push(...params);
  return result;
}
