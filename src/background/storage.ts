import type { RequestEntry } from "../lib/types";

const STORAGE_VERSION_KEY = "storageVersion";
const STORAGE_VERSION = 1;
const QUEUE_SNAPSHOT_KEY = "queueSnapshot";

function storageArea() {
  const anyStorage = browser.storage as any;
  return anyStorage.session || browser.storage.local;
}

export async function ensureStorageVersion(): Promise<void> {
  try {
    const cur = await browser.storage.local.get(STORAGE_VERSION_KEY);
    const version = cur && cur[STORAGE_VERSION_KEY];
    if (!version || version < STORAGE_VERSION) {
      await browser.storage.local.set({ [STORAGE_VERSION_KEY]: STORAGE_VERSION });
    }
  } catch (e) {
    console.warn("[MI] storage version check failed:", e);
  }
}

function sanitizeEntry(entry: RequestEntry): RequestEntry {
  const clone = JSON.parse(JSON.stringify(entry)) as RequestEntry;
  delete (clone as RequestEntry).holdResolve;
  delete (clone as RequestEntry).holdTimer;
  delete (clone as RequestEntry).capturedResponse;
  return clone;
}

export async function saveQueueSnapshot(entries: RequestEntry[]): Promise<void> {
  try {
    const payload = entries.map(sanitizeEntry);
    await storageArea().set({ [QUEUE_SNAPSHOT_KEY]: payload });
  } catch (e) {
    console.warn("[MI] saveQueueSnapshot failed:", e);
  }
}

export async function loadQueueSnapshot(): Promise<RequestEntry[]> {
  try {
    const cur = await storageArea().get(QUEUE_SNAPSHOT_KEY);
    const arr = cur && cur[QUEUE_SNAPSHOT_KEY];
    return Array.isArray(arr) ? (arr as RequestEntry[]) : [];
  } catch (e) {
    console.warn("[MI] loadQueueSnapshot failed:", e);
    return [];
  }
}
