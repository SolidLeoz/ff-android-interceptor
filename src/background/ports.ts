import type { PortMessage, RequestEntry } from "../lib/types";
import { policy } from "./policy";
import { safeClone } from "./helpers";
import { state } from "./state";
import { saveQueueSnapshot } from "./storage";

function sanitizeEntry(entry: RequestEntry): RequestEntry {
  const clone = safeClone(entry);
  delete (clone as RequestEntry).holdResolve;
  delete (clone as RequestEntry).holdTimer;
  delete (clone as RequestEntry).capturedResponse;
  return clone;
}

export function broadcast(type: PortMessage["type"], payload: PortMessage["payload"]): void {
  for (const p of state.ports) {
    try {
      p.postMessage({ type, payload } as PortMessage);
    } catch (e) {
      console.debug("[MI] port.postMessage failed:", e);
    }
  }
}

export function broadcastQueue(): void {
  broadcast("QUEUE_UPDATED", {
    interceptMode: state.interceptMode,
    size: state.queue.length,
  });
  const entries = state.queue.map((id) => state.pending.get(id)).filter(Boolean) as RequestEntry[];
  void saveQueueSnapshot(entries);
}

export function initPorts(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== "dashboard") return;

    state.ports.add(port);
    port.onDisconnect.addListener(() => state.ports.delete(port));

    const queue = state.queue.map((id) => state.pending.get(id)).filter(Boolean) as RequestEntry[];
    port.postMessage({
      type: "INIT",
      payload: {
        interceptMode: state.interceptMode,
        queue: queue.map(sanitizeEntry),
        policy,
      },
    } as PortMessage);
  });
}

export function broadcastRequestIntercepted(entry: RequestEntry): void {
  broadcast("REQUEST_INTERCEPTED", { entry: sanitizeEntry(entry) });
}

export function broadcastRequestUpdated(id: string, patch: Partial<RequestEntry>): void {
  broadcast("REQUEST_UPDATED", { id, patch });
}

export function broadcastResponseCaptured(id: string): void {
  broadcast("RESPONSE_CAPTURED", { id });
}

export function broadcastPolicyUpdated(): void {
  broadcast("POLICY_UPDATED", { policy });
}
