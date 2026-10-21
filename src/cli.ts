#!/usr/bin/env bun
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { convertYml, YmlError, type ConvertOptions } from "./index.js";

export interface CliArgs {
  help: boolean;
  version: boolean;
  input?: string;
  output?: string;
  delimiter: string;
  bom: boolean;
  encoding: string;
  columns?: string[];
  quiet: boolean;
}

const HELP = `yml2csv — конвертер Yandex YML в CSV

Использование:
  yml2csv <файл|URL|-> [опции]
  yml2csv feed.xml > out.csv

Опции:
  -o, --output <файл>       Куда записать CSV. Без флага — на stdout
  -d, --delimiter <символ>  Разделитель полей: запятая, точка с запятой или tab
      --excel               То же, что -d ';' --bom (удобно для русского Excel)
      --bom                 Добавить UTF-8 BOM
      --no-bom              Не добавлять BOM
  -e, --encoding <имя>      auto, utf-8 или windows-1251 (по умолчанию auto)
  -c, --columns <список>    Колонки через запятую и в этом порядке
  -q, --quiet               Не печатать сводку в stderr
  -h, --help                Справка
  -v, --version             Версия

Примеры:
  yml2csv feed.xml > out.csv
  yml2csv https://shop.example/feed.yml -o out.csv --excel
  yml2csv feed.xml -e windows-1251 -c id,name,price,category
  curl -fsSL https://shop.example/feed.yml | yml2csv - > out.csv
`;

function takeValue(argv: string[], index: number, flag: string): string {
  const inline = argv[index]!.includes("=") ? argv[index]!.slice(argv[index]!.indexOf("=") + 1) : undefined;
  if (inline !== undefined && inline !== "") return inline;
  const next = argv[index + 1];
  if (!next || next.startsWith("-")) throw new YmlError(`У флага ${flag} нет значения.`);
  return next;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    version: false,
    delimiter: ",",
    bom: false,
    encoding: "auto",
    quiet: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }
    if (token === "-v" || token === "--version") {
      args.version = true;
      continue;
    }
    if (token === "-q" || token === "--quiet") {
      args.quiet = true;
      continue;
    }
    if (token === "--excel") {
      args.delimiter = ";";
      args.bom = true;
      continue;
    }
    if (token === "--bom") {
      args.bom = true;
      continue;
    }
    if (token === "--no-bom") {
      args.bom = false;
      continue;
    }
    if (token === "-o" || token === "--output" || token.startsWith("--output=")) {
      args.output = takeValue(argv, i, "--output");
      if (!token.includes("=")) i += 1;
      continue;
    }
    if (token === "-d" || token === "--delimiter" || token.startsWith("--delimiter=")) {
      args.delimiter = takeValue(argv, i, "--delimiter");
      if (!token.includes("=")) i += 1;
      continue;
    }
    if (token === "-e" || token === "--encoding" || token.startsWith("--encoding=")) {
      args.encoding = takeValue(argv, i, "--encoding");
      if (!token.includes("=")) i += 1;
      continue;
    }
    if (token === "-c" || token === "--columns" || token.startsWith("--columns=")) {
      args.columns = takeValue(argv, i, "--columns")
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean);
      if (!token.includes("=")) i += 1;
      continue;
    }
    if (token.startsWith("-") && token !== "-") throw new YmlError(`Неизвестный аргумент ${token}.`);
    positionals.push(token);
  }
  if (positionals.length > 1) throw new YmlError("Укажите один вход: файл, URL или - для stdin.");
  args.input = positionals[0];
  return args;
}

export function packageVersion(): string {
  const path = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

async function* streamFile(path: string): AsyncGenerator<Uint8Array> {
  const stream = createReadStream(path, { highWaterMark: 256 * 1024 });
  for await (const chunk of stream) {
    yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
  }
}

async function writeStream(stream: NodeJS.ReadableStream, path: string): Promise<void> {
  await pipeline(stream, createWriteStream(path));
}

async function writeWebBody(body: ReadableStream<Uint8Array>, path: string): Promise<void> {
  const output = createWriteStream(path);
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (output.write(value)) continue;
      await new Promise<void>((resolve, reject) => {
        output.once("drain", () => resolve());
        output.once("error", reject);
      });
    }
  } finally {
    reader.releaseLock();
  }
  await new Promise<void>((resolve, reject) => {
    output.end(() => resolve());
    output.once("error", reject);
  });
}

async function spool(stream: NodeJS.ReadableStream): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "yml2csv-"));
  const path = join(dir, "feed.xml");
  await writeStream(stream, path);
  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function resolveInput(input: string | undefined): Promise<{ open: () => AsyncIterable<Uint8Array>; cleanup: () => Promise<void> }> {
  if (!input || input === "-") {
    const spooled = await spool(process.stdin);
    return { open: () => streamFile(spooled.path), cleanup: spooled.cleanup };
  }
  if (/^https?:\/\//i.test(input)) {
    const response = await fetch(input);
    if (!response.ok) throw new YmlError(`Не удалось скачать фид: HTTP ${response.status}.`);
    if (!response.body) throw new YmlError("Сервер вернул пустой ответ.");
    const dir = await mkdtemp(join(tmpdir(), "yml2csv-"));
    const path = join(dir, "feed.xml");
    await writeWebBody(response.body, path);
    return { open: () => streamFile(path), cleanup: () => rm(dir, { recursive: true, force: true }) };
  }
  try {
    const info = await stat(input);
    if (!info.isFile()) throw new YmlError(`Это не файл: ${input}`);
  } catch (error) {
    if (error instanceof YmlError) throw error;
    throw new YmlError(`Файл не найден: ${input}`);
  }
  return { open: () => streamFile(input), cleanup: async () => {} };
}

function writer(stream: NodeJS.WritableStream): (chunk: string) => Promise<void> {
  return async (chunk) => {
    if (stream.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        stream.off("drain", onDrain);
        stream.off("error", onError);
      };
      stream.once("drain", onDrain);
      stream.once("error", onError);
    });
  };
}

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`yml2csv: ${message}\n${HELP}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  if (!args.input && process.stdin.isTTY) {
    process.stdout.write(HELP);
    return 0;
  }

  const output = args.output ? createWriteStream(args.output) : null;
  const target = output ?? process.stdout;
  let cleanup = async () => {};
  try {
    const resolved = await resolveInput(args.input);
    cleanup = resolved.cleanup;
    const convertOptions: ConvertOptions = {
      delimiter: args.delimiter,
      bom: args.bom,
      encoding: args.encoding,
      columns: args.columns,
      write: writer(target),
    };
    const result = await convertYml(resolved.open, convertOptions);
    if (output) {
      await new Promise<void>((resolve, reject) => {
        output.end(() => resolve());
        output.once("error", reject);
      });
    }
    if (!args.quiet) {
      process.stderr.write(`yml2csv: ${result.offerCount} предложений, ${result.columns.length} колонок\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`yml2csv: ${message}\n`);
    return 1;
  } finally {
    await cleanup();
  }
}

const entry = import.meta as { main?: boolean };
if (entry.main) {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
  });
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`yml2csv: ${message}\n`);
      process.exitCode = 1;
    });
}
