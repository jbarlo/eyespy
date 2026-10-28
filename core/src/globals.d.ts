/**
 * These are the only host globals the core may use. Node, browsers and workers all have them. The core's tsconfig
 * loads no Node or DOM typings, so any other global fails to typecheck.
 */
declare function setTimeout(fn: () => void, ms?: number): { unref?(): void }; // browsers return a number; unref?.() skips it
declare function setInterval(fn: () => void, ms?: number): unknown;
declare function clearInterval(id: unknown): void;
declare const performance: { now(): number };
declare const crypto: { subtle: { digest(alg: string, data: Uint8Array): Promise<ArrayBuffer> } };
declare class TextEncoder {
  encode(s: string): Uint8Array<ArrayBuffer>;
}
declare class TextDecoder {
  constructor(label?: string);
  decode(b: Uint8Array): string;
}
