/** Ошибка конвертации: битый XML, кодировка, аргументы CLI. */
export class YmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YmlError";
  }
}
