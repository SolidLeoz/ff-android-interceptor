import type { MessageRequest, MessageResponse, Policy, RepeaterItem, ReplayRequest } from "../lib/types";
import { appendAuditLog } from "./audit";
import { broadcastPolicyUpdated, broadcastQueue } from "./ports";
import { policy, saveMode, savePolicy } from "./policy";
import { state, RETENTION } from "./state";
import { genId, nowIso } from "./helpers";
import { replayRequest } from "./replay";
import { openDashboardTab } from "./ui";
import { dropAll, dropRequest, forwardAll, forwardRequest } from "./intercept";
import { trimArray } from "../lib/redact";

function sanitizeQueueEntry(entry: any) {
  const clone = { ...entry };
  delete clone.holdResolve;
  delete clone.holdTimer;
  delete clone.capturedResponse;
  return clone;
}

export function initMessaging(): void {
  browser.runtime.onMessage.addListener(async (msg: MessageRequest) => {
    if (!msg || !msg.type) return { ok: false, error: "Missing msg.type" } as MessageResponse;

    switch (msg.type) {
      case "OPEN_DASHBOARD": {
        try {
          await openDashboardTab();
          return { ok: true } as MessageResponse;
        } catch (e) {
          return { ok: false, error: String(e) } as MessageResponse;
        }
      }

      case "TOGGLE_INTERCEPT": {
        if (msg.mode) {
          state.interceptMode = msg.mode;
        } else {
          state.interceptMode = msg.enabled ? "INTERCEPT" : "OFF";
        }
        await saveMode(state.interceptMode);
        if (state.interceptMode !== "INTERCEPT") {
          for (const entry of state.pending.values()) {
            if (entry.holdResolve) {
              if (entry.holdTimer) clearTimeout(entry.holdTimer);
              entry.holdResolve({});
              entry.holdResolve = undefined;
            }
          }
          state.pending.clear();
          state.queue = [];
        }
        broadcastQueue();
        await appendAuditLog("TOGGLE_INTERCEPT", { mode: state.interceptMode });
        return { ok: true, interceptMode: state.interceptMode } as MessageResponse;
      }

      case "GET_QUEUE": {
        const queueEntries = state.queue
          .map((id) => state.pending.get(id))
          .filter(Boolean)
          .map((entry) => sanitizeQueueEntry(entry)) as any[];
        return { ok: true, interceptMode: state.interceptMode, queue: queueEntries } as MessageResponse;
      }

      case "DROP_REQUEST": {
        await dropRequest(msg.id);
        return { ok: true } as MessageResponse;
      }

      case "FORWARD_REQUEST": {
        const res = await forwardRequest(msg.id, msg.edited);
        return (res.ok
          ? { ok: true, response: res.response }
          : { ok: false, error: res.error || "Request not held" }) as MessageResponse;
      }

      case "SAVE_REPEATER_ITEM": {
        try {
          const item: RepeaterItem = msg.item;
          const key = "repeaterItems";
          const cur = await browser.storage.local.get(key);
          let arr: RepeaterItem[] = Array.isArray(cur[key]) ? cur[key] : [];
          arr.push({ ...item, savedAt: nowIso(), id: genId() });
          arr = trimArray(arr, RETENTION.repeater);
          await browser.storage.local.set({ [key]: arr });
          return { ok: true, count: arr.length } as MessageResponse;
        } catch (e) {
          return { ok: false, error: String(e) } as MessageResponse;
        }
      }

      case "LIST_REPEATER_ITEMS": {
        const key = "repeaterItems";
        const cur = await browser.storage.local.get(key);
        return { ok: true, items: Array.isArray(cur[key]) ? cur[key] : [] } as MessageResponse;
      }

      case "RUN_REPEATER_ITEM": {
        const request: ReplayRequest = msg.request;
        const resp = await replayRequest(request);
        return { ok: true, response: resp } as MessageResponse;
      }

      case "DELETE_REPEATER_ITEM": {
        try {
          const key = "repeaterItems";
          const cur = await browser.storage.local.get(key);
          const arr: RepeaterItem[] = Array.isArray(cur[key]) ? cur[key] : [];
          const next = arr.filter((x) => x.id !== msg.id);
          await browser.storage.local.set({ [key]: next });
          return { ok: true, count: next.length } as MessageResponse;
        } catch (e) {
          return { ok: false, error: String(e) } as MessageResponse;
        }
      }

      case "GET_POLICY": {
        return { ok: true, policy } as MessageResponse;
      }

      case "SET_POLICY": {
        const POLICY_KEYS: (keyof Policy)[] = [
          "scopeMode",
          "allowDomains",
          "allowUrlContains",
          "bypassStaticAssets",
          "bypassTypes",
          "bypassOptions",
        ];
        const incoming = msg.policy || {};
        for (const k of POLICY_KEYS) {
          if (k in incoming) (policy as any)[k] = (incoming as any)[k];
        }
        await savePolicy();
        broadcastPolicyUpdated();
        await appendAuditLog("POLICY_CHANGE", { scopeMode: policy.scopeMode, count: policy.allowDomains.length });
        return { ok: true, policy } as MessageResponse;
      }

      case "DROP_ALL": {
        await dropAll();
        return { ok: true } as MessageResponse;
      }

      case "FORWARD_ALL": {
        const res = await forwardAll();
        return { ok: true, forwarded: res.forwarded, failed: res.failed } as MessageResponse;
      }

      case "SAVE_NOTE": {
        try {
          const noteKey = "interceptorNotes";
          const cur = await browser.storage.local.get(noteKey);
          let arr = Array.isArray(cur[noteKey]) ? cur[noteKey] : [];
          arr.push({
            id: genId(),
            timestamp: nowIso(),
            memo: msg.memo || "",
            request: msg.request || null,
            response: msg.response || null,
          });
          arr = trimArray(arr, RETENTION.notes);
          await browser.storage.local.set({ [noteKey]: arr });
          return { ok: true, count: arr.length } as MessageResponse;
        } catch (e) {
          return { ok: false, error: String(e) } as MessageResponse;
        }
      }

      case "LIST_NOTES": {
        const noteKey = "interceptorNotes";
        const cur = await browser.storage.local.get(noteKey);
        return { ok: true, notes: Array.isArray(cur[noteKey]) ? cur[noteKey] : [] } as MessageResponse;
      }

      case "DELETE_NOTE": {
        try {
          const noteKey = "interceptorNotes";
          const cur = await browser.storage.local.get(noteKey);
          const arr = Array.isArray(cur[noteKey]) ? cur[noteKey] : [];
          const next = arr.filter((x: { id: string }) => x.id !== msg.id);
          await browser.storage.local.set({ [noteKey]: next });
          return { ok: true, count: next.length } as MessageResponse;
        } catch (e) {
          return { ok: false, error: String(e) } as MessageResponse;
        }
      }

      case "CLEAR_NOTES": {
        try {
          await browser.storage.local.set({ interceptorNotes: [] });
          return { ok: true } as MessageResponse;
        } catch (e) {
          return { ok: false, error: String(e) } as MessageResponse;
        }
      }

      case "LIST_AUDIT_LOG": {
        const cur = await browser.storage.local.get("interceptorAuditLog");
        return { ok: true, log: Array.isArray(cur.interceptorAuditLog) ? cur.interceptorAuditLog : [] } as MessageResponse;
      }

      case "CLEAR_AUDIT_LOG": {
        try {
          await browser.storage.local.set({ interceptorAuditLog: [] });
          return { ok: true } as MessageResponse;
        } catch (e) {
          return { ok: false, error: String(e) } as MessageResponse;
        }
      }

      default:
        return { ok: false, error: "Unknown message type" } as MessageResponse;
    }
  });
}
