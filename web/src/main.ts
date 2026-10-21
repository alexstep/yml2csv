import sampleXml from "../../examples/shop.xml?raw";
import { convertYml, YmlError, type ByteSource, type ConvertOptions } from "../../src/index.js";

const tabFile = document.querySelector<HTMLButtonElement>("#tab-file")!;
const tabUrl = document.querySelector<HTMLButtonElement>("#tab-url")!;
const panelFile = document.querySelector<HTMLElement>("#panel-file")!;
const panelUrl = document.querySelector<HTMLElement>("#panel-url")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const fileName = document.querySelector<HTMLElement>("#file-name")!;
const drop = document.querySelector<HTMLElement>("#drop")!;
const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const delimiterInput = document.querySelector<HTMLSelectElement>("#delimiter")!;
const encodingInput = document.querySelector<HTMLSelectElement>("#encoding")!;
const bomInput = document.querySelector<HTMLInputElement>("#bom")!;
const columnsInput = document.querySelector<HTMLInputElement>("#columns")!;
const convertButton = document.querySelector<HTMLButtonElement>("#convert")!;
const excelButton = document.querySelector<HTMLButtonElement>("#excel")!;
const sampleButton = document.querySelector<HTMLButtonElement>("#sample")!;
const downloadButton = document.querySelector<HTMLButtonElement>("#download")!;
const statusNode = document.querySelector<HTMLElement>("#status")!;
const errorNode = document.querySelector<HTMLElement>("#error")!;
const resultNode = document.querySelector<HTMLElement>("#result")!;
const summaryNode = document.querySelector<HTMLElement>("#summary")!;
const preview = document.querySelector<HTMLTableElement>("#preview")!;

let selectedFile: File | null = null;
let downloadUrl: string | undefined;
let busy = false;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) void registration.unregister();
  }).catch(() => {});
}

function setTab(tab: "file" | "url") {
  const file = tab === "file";
  tabFile.setAttribute("aria-selected", String(file));
  tabUrl.setAttribute("aria-selected", String(!file));
  panelFile.hidden = !file;
  panelUrl.hidden = file;
}

function setBusy(value: boolean) {
  busy = value;
  convertButton.disabled = value;
  sampleButton.disabled = value;
  downloadButton.disabled = value;
}

function showError(message: string) {
  errorNode.hidden = false;
  errorNode.textContent = message;
  statusNode.textContent = "";
}

function clearError() {
  errorNode.hidden = true;
  errorNode.textContent = "";
}

function renderPreview(rows: string[][]) {
  preview.replaceChildren();
  const headRow = rows[0];
  if (!headRow) return;
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  for (const cell of headRow) {
    const th = document.createElement("th");
    th.textContent = cell;
    header.append(th);
  }
  thead.append(header);
  const tbody = document.createElement("tbody");
  for (const cells of rows.slice(1)) {
    const tr = document.createElement("tr");
    for (const cell of cells) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.append(td);
    }
    tbody.append(tr);
  }
  preview.append(thead, tbody);
}

function rememberFile(file: File | null) {
  selectedFile = file;
  fileName.textContent = file ? `${file.name} · ${formatSize(file.size)}` : "или выберите файл на диске";
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

function options(): ConvertOptions {
  const columns = columnsInput.value
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  return {
    delimiter: delimiterInput.value,
    bom: bomInput.checked,
    encoding: encodingInput.value,
    columns: columns.length ? columns : undefined,
  };
}

function openBlob(blob: Blob): () => AsyncGenerator<Uint8Array> {
  return async function* chunks(): AsyncGenerator<Uint8Array> {
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}

async function sourceFromUrl(url: string): Promise<{ open: () => ByteSource; filename: string }> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new YmlError(
      "Браузер не смог скачать фид: сервер не разрешает CORS. Сохраните файл и откройте его здесь или запустите yml2csv в терминале.",
    );
  }
  if (!response.ok) throw new YmlError(`Не удалось скачать фид: HTTP ${response.status}.`);
  const blob = await response.blob();
  if (blob.size === 0) throw new YmlError("По ссылке пустой ответ.");
  const filename = filenameFromUrl(url);
  return { open: openBlob(blob), filename };
}

function filenameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last) return last.replace(/\.(xml|yml)$/i, "") + ".csv";
  } catch {
    /* невалидный URL поймает само поле ввода */
  }
  return "feed.csv";
}

async function run(open: () => ByteSource, filename: string): Promise<void> {
  clearError();
  setBusy(true);
  statusNode.textContent = "Читаем фид…";
  resultNode.hidden = true;
  const parts: string[] = [];
  let lastPaint = 0;
  try {
    const result = await convertYml(open, {
      ...options(),
      write: (chunk) => {
        parts.push(chunk);
      },
      onProgress: ({ pass, offers }) => {
        const now = performance.now();
        if (now - lastPaint < 150) return;
        lastPaint = now;
        statusNode.textContent = pass === 1 ? `Смотрим структуру… ${offers}` : `Пишем CSV… ${offers}`;
      },
    });
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    const blob = new Blob(parts, { type: "text/csv;charset=utf-8" });
    downloadUrl = URL.createObjectURL(blob);
    downloadButton.onclick = () => {
      const link = document.createElement("a");
      link.href = downloadUrl!;
      link.download = filename;
      link.click();
    };
    renderPreview(result.preview);
    const shown = Math.max(0, result.preview.length - 1);
    summaryNode.textContent = result.offerCount
      ? `${result.offerCount} предложений · ${result.columns.length} колонок · в таблице первые ${shown}`
      : "В фиде нет предложений.";
    statusNode.textContent = result.offerCount ? "Готово. CSV можно скачать." : "Файл прочитан, предложений не нашлось.";
    resultNode.hidden = false;
    resultNode.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showError(message);
  } finally {
    setBusy(false);
  }
}

tabFile.addEventListener("click", () => setTab("file"));
tabUrl.addEventListener("click", () => setTab("url"));

fileInput.addEventListener("change", () => {
  rememberFile(fileInput.files?.[0] ?? null);
});

drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.classList.add("dragover");
});
drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("dragover");
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  rememberFile(file);
  setTab("file");
});

excelButton.addEventListener("click", () => {
  delimiterInput.value = ";";
  bomInput.checked = true;
  statusNode.textContent = "Разделитель «;» и BOM включены — так русский Excel открывает CSV сам.";
});

convertButton.addEventListener("click", () => {
  if (busy) return;
  if (!panelUrl.hidden) {
    const url = urlInput.value.trim();
    if (!url) {
      showError("Вставьте ссылку на YML.");
      return;
    }
    void sourceFromUrl(url)
      .then((source) => run(source.open, source.filename))
      .catch((error: unknown) => showError(error instanceof Error ? error.message : String(error)));
    return;
  }
  if (!selectedFile) {
    showError("Выберите YML-файл или откройте пример.");
    return;
  }
  const filename = selectedFile.name.replace(/\.(xml|yml)$/i, "") + ".csv";
  void run(openBlob(selectedFile), filename);
});

sampleButton.addEventListener("click", () => {
  if (busy) return;
  setTab("file");
  rememberFile(null);
  fileInput.value = "";
  void run(() => [new TextEncoder().encode(sampleXml)], "example.csv");
});
