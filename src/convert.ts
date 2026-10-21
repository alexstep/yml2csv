import { formatCsvRow, normalizeDelimiter, orderColumns } from "./csv.js";
import { YmlError } from "./errors.js";
import { normalizeEncoding, type EncodingChoice } from "./encoding.js";
import { categoryPath, parseYml, type ByteSource, type OfferDraft } from "./parse.js";

export type { ByteSource } from "./parse.js";
export { categoryPath };

const PREVIEW_DATA_ROWS = 8;

export interface ConvertOptions {
  /** Разделитель полей. По умолчанию запятая. Для русского Excel — `;`. */
  delimiter?: string;
  /** Добавить UTF-8 BOM в начало файла, чтобы Excel узнал кодировку. */
  bom?: boolean;
  /** Явный список и порядок колонок. Пустые значения остаются пустыми ячейками. */
  columns?: readonly string[];
  /** Кодировка входного XML. По умолчанию определяется по декларации. */
  encoding?: EncodingChoice | string;
  /** Куда писать готовые куски CSV. Если не задан, весь текст вернётся в `csv`. */
  write?: (chunk: string) => void | Promise<void>;
  onProgress?: (info: { pass: 1 | 2; offers: number }) => void;
}

export interface ConvertResult {
  offerCount: number;
  columns: string[];
  /** Заголовок и первые строки данных — для превью в браузере. */
  preview: string[][];
  /** Полный CSV, если вывод не перехватывался через `write`. */
  csv?: string;
}

function selectedColumns(requested: readonly string[] | undefined, seen: readonly string[]): string[] {
  if (!requested) return orderColumns(seen);
  const columns = requested.map((column) => column.trim()).filter(Boolean);
  if (columns.length === 0) throw new YmlError("Список колонок пуст.");
  return columns;
}

/**
 * Два прохода по фиду: сначала имена колонок и дерево категорий, затем запись CSV.
 * Сам XML не складывается в дерево и не держится в памяти целиком.
 * `open` вызывается дважды и каждый раз должен отдавать фид с начала.
 */
export async function convertYml(open: () => ByteSource, options: ConvertOptions = {}): Promise<ConvertResult> {
  const delimiter = normalizeDelimiter(options.delimiter);
  const bom = options.bom ?? false;
  const encoding = normalizeEncoding(options.encoding);
  const categories = new Map<string, { id: string; parentId?: string; name: string }>();
  const seen: string[] = [];
  const seenSet = new Set<string>();
  let scanned = 0;

  await parseYml(open(), {
    encoding,
    categories,
    pathsReady: false,
    onOffer(offer) {
      scanned += 1;
      for (const key of offer.order) {
        if (seenSet.has(key)) continue;
        seenSet.add(key);
        seen.push(key);
      }
      options.onProgress?.({ pass: 1, offers: scanned });
    },
  });

  const columns = selectedColumns(options.columns, seen);
  const preview: string[][] = [];
  const captured: string[] = [];
  const pending: string[] = [];
  let offerCount = 0;

  const emit = (chunk: string) => {
    pending.push(chunk);
  };
  const flush = async () => {
    if (pending.length === 0) return;
    const chunks = pending.splice(0, pending.length);
    for (const chunk of chunks) {
      if (options.write) await options.write(chunk);
      else captured.push(chunk);
    }
  };

  const writeHeader = columns.length > 0 && (options.columns !== undefined || seen.length > 0);
  if (writeHeader) {
    const prefix = bom ? "\uFEFF" : "";
    emit(prefix + formatCsvRow(columns, delimiter) + "\r\n");
    preview.push([...columns]);
  }

  const writeOffer = (offer: OfferDraft) => {
    offerCount += 1;
    options.onProgress?.({ pass: 2, offers: offerCount });
    if (!writeHeader) return;
    const values = columns.map((column) => offer.fields.get(column) ?? "");
    emit(formatCsvRow(values, delimiter) + "\r\n");
    if (preview.length <= PREVIEW_DATA_ROWS) preview.push(values);
  };

  await parseYml(open(), {
    encoding,
    categories,
    pathsReady: true,
    onOffer: writeOffer,
    onIdle: flush,
  });
  await flush();

  return {
    offerCount,
    columns,
    preview,
    csv: options.write ? undefined : captured.join(""),
  };
}

/** Удобная обёртка для уже декодированной строки Unicode (UTF-8). */
export function convertYmlText(text: string, options?: ConvertOptions): Promise<ConvertResult> {
  const bytes = new TextEncoder().encode(text);
  return convertYml(() => [bytes], options);
}
