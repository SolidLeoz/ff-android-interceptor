export async function openDashboardTab(): Promise<void> {
  const url = browser.runtime.getURL("ui/dashboard.html");
  try {
    const tabs = await browser.tabs.query({});
    const existing = tabs.find((t) => (t.url || "").startsWith(url));
    if (existing && existing.id) {
      await browser.tabs.update(existing.id, { active: true });
      return;
    }
  } catch (e) {
    console.warn("[MI] openDashboardTab query failed:", e);
  }
  await browser.tabs.create({ url });
}
