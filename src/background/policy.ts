import type { InterceptMode, Policy } from "../lib/types";

export const POLICY_KEY = "interceptorPolicy";
export const AUDIT_KEY = "interceptorAuditLog";
export const MODE_KEY = "interceptMode";

export const policy: Policy = {
  scopeMode: "ALLOWLIST",
  allowDomains: [],
  allowUrlContains: [],
  bypassStaticAssets: true,
  bypassTypes: ["image", "stylesheet", "font", "media"],
  bypassOptions: true,
};

export async function loadPolicy(): Promise<void> {
  try {
    const cur = await browser.storage.local.get(POLICY_KEY);
    if (cur && cur[POLICY_KEY]) Object.assign(policy, cur[POLICY_KEY]);
  } catch (e) {
    console.warn("[MI] loadPolicy failed:", e);
  }
}

export async function savePolicy(): Promise<boolean> {
  try {
    await browser.storage.local.set({ [POLICY_KEY]: policy });
    return true;
  } catch (e) {
    console.warn("[MI] savePolicy failed:", e);
    return false;
  }
}

export async function loadMode(): Promise<InterceptMode | null> {
  try {
    const cur = await browser.storage.local.get(MODE_KEY);
    const mode = cur && cur[MODE_KEY];
    if (mode === "OFF" || mode === "OBSERVE" || mode === "INTERCEPT") return mode;
  } catch (e) {
    console.warn("[MI] loadMode failed:", e);
  }
  return null;
}

export async function saveMode(mode: InterceptMode): Promise<void> {
  try {
    await browser.storage.local.set({ [MODE_KEY]: mode });
  } catch (e) {
    console.warn("[MI] saveMode failed:", e);
  }
}
