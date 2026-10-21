import { SaxesParser, type SaxesOptions, type SaxesTagPlain } from "saxes";
import { YmlError } from "./errors.js";
import {
  createDecoder,
  detectEncoding,
  stripUtf8Bom,
  type EncodingChoice,
  type EncodingName,
} from "./encoding.js";

export interface Category {
  id: string;
  parentId?: string;
  name: string;
}

export interface OfferDraft {
  fields: Map<string, string>;
  order: string[];
}

export type ByteSource = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

interface Frame {
  name: string;
  attrs: Record<string, string>;
  text: string;
  childElements: number;
  parts: string[];
  extra: Record<string, string>;
  offer?: OfferDraft;
}

export interface ParseOptions {
  encoding: EncodingChoice;
  categories: Map<string, Category>;
  /** Во втором проходе карта категорий уже полная, путь можно строить сразу. */
  pathsReady: boolean;
  onOffer: (offer: OfferDraft) => void;
  onIdle?: () => void | Promise<void>;
}

const PARENTS_THAT_CONSUME_CHILDREN = new Set([
  "delivery-options",
  "pickup-options",
  "outlets",
  "condition",
  "video",
  "categories",
  "offers",
]);

function normalizeText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function appendField(offer: OfferDraft, key: string, value: string): void {
  const previous = offer.fields.get(key);
  if (previous === undefined) {
    offer.fields.set(key, value);
    offer.order.push(key);
    return;
  }
  if (!value) return;
  offer.fields.set(key, previous ? `${previous}|${value}` : value);
}

function putField(offer: OfferDraft, key: string, value: string): void {
  if (!offer.fields.has(key)) offer.order.push(key);
  offer.fields.set(key, value);
}

function formatAttrs(attrs: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === "") continue;
    parts.push(`${key}=${value}`);
  }
  return parts.join(";");
}

export function categoryPath(id: string, categories: Map<string, Category>): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const category = categories.get(current);
    if (!category) break;
    names.push(category.name);
    current = category.parentId;
  }
  names.reverse();
  return names.join(" > ");
}

function findOffer(stack: readonly Frame[]): Frame | undefined {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const frame = stack[i];
    if (frame?.offer) return frame;
  }
  return undefined;
}

async function* iterateBytes(source: ByteSource): AsyncGenerator<Uint8Array> {
  yield* source as AsyncIterable<Uint8Array>;
}

async function readHead(source: ByteSource, size: number): Promise<{ head: Uint8Array; rest: AsyncGenerator<Uint8Array> }> {
  const iterator = iterateBytes(source)[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < size) {
    const next = await iterator.next();
    if (next.done) break;
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  const head = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    head.set(chunk, offset);
    offset += chunk.byteLength;
  }
  async function* rest(): AsyncGenerator<Uint8Array> {
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }
  return { head, rest: rest() };
}

function handleClose(frame: Frame, parent: Frame | undefined, stack: Frame[], options: ParseOptions): void {
  const text = normalizeText(frame.text);

  if (frame.name === "category" && parent?.name === "categories") {
    const id = frame.attrs.id ?? "";
    if (!id) return;
    const parentId = frame.attrs.parentId || frame.attrs.parent_id || undefined;
    options.categories.set(id, { id, name: text, parentId });
    return;
  }

  if (frame.name === "offer") {
    const offer = frame.offer;
    if (!offer) return;
    if (offer.fields.has("categoryId")) {
      const id = offer.fields.get("categoryId") ?? "";
      const path = options.pathsReady ? categoryPath(id, options.categories) : "";
      putField(offer, "category", path);
    }
    options.onOffer(offer);
    return;
  }

  const offer = findOffer(stack)?.offer;
  if (!offer) return;

  if (frame.name === "param" && parent?.name === "offer") {
    const paramName = (frame.attrs.name ?? "").trim();
    const unit = (frame.attrs.unit ?? "").trim();
    const key = paramName ? (unit ? `param:${paramName} [${unit}]` : `param:${paramName}`) : "param";
    appendField(offer, key, text);
    return;
  }

  if (frame.name === "option" && parent && (parent.name === "delivery-options" || parent.name === "pickup-options")) {
    const body = formatAttrs(frame.attrs);
    if (body) parent.parts.push(body);
    return;
  }

  if (frame.name === "outlet" && parent?.name === "outlets") {
    const body = formatAttrs(frame.attrs);
    const value = [body, text].filter(Boolean).join(";");
    if (value) parent.parts.push(value);
    return;
  }

  if ((frame.name === "reason" || frame.name === "quality") && parent?.name === "condition") {
    parent.extra[frame.name] = text;
    return;
  }

  if (frame.name === "url" && parent?.name === "video") {
    if (text) parent.parts.push(text);
    return;
  }

  if (parent?.name === "offer") {
    if (frame.name === "delivery-options" || frame.name === "pickup-options" || frame.name === "outlets") {
      const column =
        frame.name === "delivery-options" ? "delivery_options" : frame.name === "pickup-options" ? "pickup_options" : "outlets";
      if (frame.parts.length > 0) appendField(offer, column, frame.parts.join("|"));
      return;
    }
    if (frame.name === "condition") {
      if (frame.attrs.type) appendField(offer, "condition", frame.attrs.type);
      if (frame.extra.quality) appendField(offer, "condition_quality", frame.extra.quality);
      if (frame.extra.reason) appendField(offer, "condition_reason", frame.extra.reason);
      return;
    }
    if (frame.name === "video") {
      const value = frame.parts.length > 0 ? frame.parts.join("|") : text;
      if (value) appendField(offer, "video", value);
      return;
    }
    if (frame.childElements === 0) {
      if (text) appendField(offer, frame.name, text);
      if ((frame.name === "price" || frame.name === "oldprice") && frame.attrs.from) {
        appendField(offer, `${frame.name}_from`, frame.attrs.from);
      } else if (frame.name === "age" && frame.attrs.unit) {
        appendField(offer, "age_unit", frame.attrs.unit);
      } else {
        for (const [key, value] of Object.entries(frame.attrs)) {
          if (value) appendField(offer, `${frame.name}_${key}`, value);
        }
      }
    }
    return;
  }

  if (frame.childElements === 0 && parent && !PARENTS_THAT_CONSUME_CHILDREN.has(parent.name) && text) {
    appendField(offer, `${parent.name}_${frame.name}`, text);
  }
}

function openFrame(tag: SaxesTagPlain): Frame {
  const frame: Frame = {
    name: tag.name,
    attrs: tag.attributes,
    text: "",
    childElements: 0,
    parts: [],
    extra: {},
  };
  if (tag.name === "offer") {
    const offer: OfferDraft = { fields: new Map(), order: [] };
    frame.offer = offer;
    for (const [key, value] of Object.entries(tag.attributes)) {
      if (value !== "") appendField(offer, key, value);
    }
  }
  return frame;
}

export async function parseYml(source: ByteSource, options: ParseOptions): Promise<EncodingName> {
  const { head, rest } = await readHead(source, 4096);
  if (head.byteLength === 0) throw new YmlError("Файл пуст.");
  const encoding = detectEncoding(head, options.encoding);
  const decode = createDecoder(encoding);
  const parser = new SaxesParser<SaxesOptions & { xmlns: false }>({
    xmlns: false,
    position: true,
    fileName: "feed.xml",
  });
  const stack: Frame[] = [];

  const fail = (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error);
    throw new YmlError(`Некорректный XML (${message}).`);
  };

  parser.on("opentag", (tag) => {
    stack.push(openFrame(tag));
  });
  parser.on("text", (chunk) => {
    const top = stack[stack.length - 1];
    if (top) top.text += chunk;
  });
  parser.on("cdata", (chunk) => {
    const top = stack[stack.length - 1];
    if (top) top.text += chunk;
  });
  parser.on("closetag", () => {
    const frame = stack.pop();
    if (!frame) return;
    const parent = stack[stack.length - 1];
    if (parent) parent.childElements += 1;
    handleClose(frame, parent, stack, options);
  });

  const write = (chunk: string) => {
    if (!chunk) return;
    try {
      parser.write(chunk);
    } catch (error) {
      fail(error);
    }
  };

  write(decode(stripUtf8Bom(head), false));
  if (options.onIdle) await options.onIdle();
  for await (const chunk of rest) {
    write(decode(chunk, false));
    if (options.onIdle) await options.onIdle();
  }
  write(decode(new Uint8Array(), true));
  try {
    parser.close();
  } catch (error) {
    fail(error);
  }
  return encoding;
}
