import type { AuditEntry } from "../lib/types";
import { redactUrl, trimArray } from "../lib/redact";
import { nowIso } from "./helpers";
import { AUDIT_KEY } from "./policy";
import { RETENTION } from "./state";

export async function appendAuditLog(action: string, details: Partial<AuditEntry>): Promise<void> {
  try {
    const redacted: Partial<AuditEntry> = { ...details };
    if (redacted.url) redacted.url = redactUrl(redacted.url);
    const cur = await browser.storage.local.get(AUDIT_KEY);
    let log: AuditEntry[] = Array.isArray(cur[AUDIT_KEY]) ? cur[AUDIT_KEY] : [];
    log.push({ timestamp: nowIso(), action, ...redacted } as AuditEntry);
    log = trimArray(log, RETENTION.audit);
    await browser.storage.local.set({ [AUDIT_KEY]: log });
  } catch (e) {
    console.warn("[MI] appendAuditLog failed:", e);
  }
}

export async function listAuditLog(): Promise<AuditEntry[]> {
  const cur = await browser.storage.local.get(AUDIT_KEY);
  return Array.isArray(cur[AUDIT_KEY]) ? cur[AUDIT_KEY] : [];
}

export async function clearAuditLog(): Promise<void> {
  await browser.storage.local.set({ [AUDIT_KEY]: [] });
}
