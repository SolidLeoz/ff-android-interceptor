export function nowIso(): string {
  return new Date().toISOString();
}

export function safeClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export function genId(): string {
  return globalThis.crypto && "randomUUID" in globalThis.crypto
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function bufToBase64(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function denormalizeHeaders(headersObj: Record<string, string> | undefined): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(headersObj || {})) {
    try {
      h.set(k, String(v));
    } catch (e) {
      console.debug("[MI] header set failed:", k, e);
    }
  }
  return h;
}

export function mergeChunks(chunks: Uint8Array[]): ArrayBuffer {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged.buffer;
}

export function headersObjToArray(obj: Record<string, string> | undefined): browser.webRequest.HttpHeader[] {
  return Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
}
