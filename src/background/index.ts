import { ensureStorageVersion, loadQueueSnapshot } from "./storage";
import { initMessaging } from "./messaging";
import { initPorts } from "./ports";
import { initWebRequestListeners } from "./intercept";
import { loadMode, loadPolicy } from "./policy";
import { state } from "./state";
import { openDashboardTab } from "./ui";

async function init(): Promise<void> {
  await ensureStorageVersion();
  await loadPolicy();
  const mode = await loadMode();
  if (mode) state.interceptMode = mode;
  const snapshot = await loadQueueSnapshot();
  if (snapshot.length) {
    for (const entry of snapshot) {
      entry.observe = true;
      entry.note = entry.note || "Restored from previous session (read-only)";
      delete (entry as any).holdResolve;
      delete (entry as any).holdTimer;
      delete (entry as any).capturedResponse;
      state.pending.set(entry.id, entry);
      state.queue.push(entry.id);
    }
  }

  initPorts();
  initMessaging();
  initWebRequestListeners();

  if (browser.action && browser.action.onClicked) {
    browser.action.onClicked.addListener(() => {
      openDashboardTab().catch((e) => console.log("[MI] openDashboardTab error:", e));
    });
  } else if ((browser as any).browserAction?.onClicked) {
    (browser as any).browserAction.onClicked.addListener(() => {
      openDashboardTab().catch((e: unknown) => console.log("[MI] openDashboardTab error:", e));
    });
  }
}

init().catch((e) => console.error("[MI] init failed:", e));
