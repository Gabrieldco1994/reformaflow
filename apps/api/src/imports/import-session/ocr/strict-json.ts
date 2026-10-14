const MAX_JSON_DEPTH = 32;
const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX = /^[0-9a-fA-F]{4}$/;

class StrictJsonReader {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace();
    this.value(0);
    this.skipWhitespace();
    if (this.offset !== this.source.length) this.invalid();
    return JSON.parse(this.source) as unknown;
  }

  private value(depth: number): void {
    if (depth > MAX_JSON_DEPTH) this.invalid();
    const token = this.source[this.offset];
    if (token === "{") return this.object(depth + 1);
    if (token === "[") return this.array(depth + 1);
    if (token === '"') {
      this.string();
      return;
    }
    if (token === "-" || (token !== undefined && token >= "0" && token <= "9"))
      return this.number();
    if (this.source.startsWith("true", this.offset)) {
      this.offset += 4;
      return;
    }
    if (this.source.startsWith("false", this.offset)) {
      this.offset += 5;
      return;
    }
    if (this.source.startsWith("null", this.offset)) {
      this.offset += 4;
      return;
    }
    this.invalid();
  }

  private object(depth: number): void {
    this.offset++;
    this.skipWhitespace();
    if (this.consume("}")) return;
    const keys = new Set<string>();
    for (;;) {
      if (this.source[this.offset] !== '"') this.invalid();
      const key = this.string();
      if (keys.has(key)) this.invalid();
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) this.invalid();
      this.skipWhitespace();
      this.value(depth);
      this.skipWhitespace();
      if (this.consume("}")) return;
      if (!this.consume(",")) this.invalid();
      this.skipWhitespace();
    }
  }

  private array(depth: number): void {
    this.offset++;
    this.skipWhitespace();
    if (this.consume("]")) return;
    for (;;) {
      this.value(depth);
      this.skipWhitespace();
      if (this.consume("]")) return;
      if (!this.consume(",")) this.invalid();
      this.skipWhitespace();
    }
  }

  private string(): string {
    const start = this.offset;
    this.offset++;
    for (;;) {
      const token = this.source[this.offset];
      if (token === undefined) this.invalid();
      if (token === '"') {
        this.offset++;
        const value: unknown = JSON.parse(
          this.source.slice(start, this.offset),
        );
        if (typeof value !== "string") this.invalid();
        return value;
      }
      if (token === "\\") {
        this.offset++;
        const escape = this.source[this.offset];
        if (escape === "u") {
          const digits = this.source.slice(this.offset + 1, this.offset + 5);
          if (!HEX.test(digits)) this.invalid();
          this.offset += 5;
          continue;
        }
        if (
          escape !== '"' &&
          escape !== "\\" &&
          escape !== "/" &&
          escape !== "b" &&
          escape !== "f" &&
          escape !== "n" &&
          escape !== "r" &&
          escape !== "t"
        )
          this.invalid();
        this.offset++;
        continue;
      }
      if (token.charCodeAt(0) <= 0x1f) this.invalid();
      this.offset++;
    }
  }

  private number(): void {
    NUMBER.lastIndex = this.offset;
    const match = NUMBER.exec(this.source);
    if (!match) this.invalid();
    this.offset = NUMBER.lastIndex;
  }

  private skipWhitespace(): void {
    while (JSON_WHITESPACE.has(this.source[this.offset] ?? "")) this.offset++;
  }

  private consume(token: string): boolean {
    if (this.source[this.offset] !== token) return false;
    this.offset++;
    return true;
  }

  private invalid(): never {
    throw new SyntaxError("STRICT_JSON_INVALID");
  }
}

/** Parses strict JSON while rejecting duplicate object keys at every depth. */
export function parseStrictJson(source: string): unknown {
  if (typeof source !== "string" || source.length === 0)
    throw new SyntaxError("STRICT_JSON_INVALID");
  return new StrictJsonReader(source).parse();
}
