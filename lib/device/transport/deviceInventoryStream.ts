import { StringDecoder } from 'node:string_decoder';

/** Valid JSON whose object enumeration semantics require the ordinary buffered reader. */
export const bufferedDeviceInventoryRequired = new Error('Device inventory requires buffered object enumeration');

type State = 'root' | 'first' | 'entry' | 'key' | 'colon' | 'value' | 'done';
type Boundary = 'none' | 'start' | 'after-colon' | 'key' | 'value';

const whitespace = (char: string): boolean => char === ' ' || char === '\t' || char === '\r' || char === '\n';
const invalidInventory = (): SyntaxError => new SyntaxError('Invalid JSON device inventory');

/** Scan only collection structure. JSON.parse validates each key and each complete entry. */
class DeviceInventoryScanner {
  private state: State = 'root';
  private close = '';
  private readonly keys = new Set<string>();
  private parts: string[] = [];
  private inString = false;
  private escaped = false;
  private depth = 0;

  *read(chunk: string): Generator<unknown> {
    let start = this.state === 'key' || this.state === 'value' ? 0 : -1;
    for (let index = 0; index < chunk.length; index += 1) {
      switch (this.scan(chunk.charAt(index))) {
        case 'start':
          start = index;
          break;
        case 'after-colon':
          start = index + 1;
          break;
        case 'key':
          this.readKey(chunk.slice(start, index + 1));
          start = -1;
          break;
        case 'value':
          yield this.parse(chunk.slice(start, index));
          start = -1;
          break;
        default:
          break;
      }
    }
    if (start >= 0 && start < chunk.length) this.parts.push(chunk.slice(start));
  }

  private scan(char: string): Boundary {
    if (this.inString) return this.scanString(char);
    if (this.state === 'value') return this.scanValue(char);
    if (whitespace(char)) return 'none';
    switch (this.state) {
      case 'root':
        if (char !== '{' && char !== '[') throw invalidInventory();
        this.close = char === '{' ? '}' : ']';
        this.state = 'first';
        return 'none';
      case 'colon':
        if (char !== ':') throw invalidInventory();
        this.state = 'value';
        return 'after-colon';
      case 'first':
        if (char === this.close) {
          this.state = 'done';
          return 'none';
        }
        return this.startEntry(char);
      case 'entry':
        return this.startEntry(char);
      default:
        throw invalidInventory();
    }
  }

  private startEntry(char: string): Boundary {
    if (this.close === '}') {
      if (char !== '"') throw invalidInventory();
      this.state = 'key';
      this.inString = true;
    } else {
      if (char === ',' || char === ']') throw invalidInventory();
      this.state = 'value';
      this.scanValue(char);
    }
    return 'start';
  }

  private scanString(char: string): Boundary {
    if (this.escaped) {
      this.escaped = false;
      return 'none';
    }
    if (char === '\\') this.escaped = true;
    if (char !== '"') return 'none';
    this.inString = false;
    if (this.state !== 'key') return 'none';
    this.state = 'colon';
    return 'key';
  }

  private scanValue(char: string): Boundary {
    if (this.depth === 0 && (char === ',' || char === this.close)) {
      this.state = char === ',' ? 'entry' : 'done';
      return 'value';
    }
    if (char === '"') this.inString = true;
    else if (char === '{' || char === '[') this.depth += 1;
    else if (char === '}' || char === ']') this.depth -= 1;
    return 'none';
  }

  finish(): void {
    if (this.state !== 'done') throw invalidInventory();
  }

  private parse(lastPart: string): unknown {
    const text = this.parts.length === 0 ? lastPart : [...this.parts, lastPart].join('');
    this.parts = [];
    try { return JSON.parse(text); } catch { throw invalidInventory(); }
  }

  private readKey(lastPart: string): void {
    const key = this.parse(lastPart);
    if (typeof key !== 'string') throw invalidInventory();
    // Object.values sorts array indices; JSON.parse keeps the final value for duplicate keys.
    const index = Number(key) >>> 0;
    if (this.keys.has(key) || (index !== 0xffffffff && String(index) === key)) {
      throw bufferedDeviceInventoryRequired;
    }
    this.keys.add(key);
  }
}

/** Accept Homey's ID-keyed object and its older array representation. */
export async function* readDeviceInventoryEntries(chunks: AsyncIterable<Buffer>): AsyncGenerator<unknown> {
  const scanner = new DeviceInventoryScanner();
  const decoder = new StringDecoder('utf8');
  for await (const chunk of chunks) yield* scanner.read(decoder.write(chunk));
  yield* scanner.read(decoder.end());
  scanner.finish();
}
