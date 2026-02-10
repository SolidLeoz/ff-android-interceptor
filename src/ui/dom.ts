export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}

export const topbar = el<HTMLDivElement>("topbar");
export const interceptModeSelect = el<HTMLSelectElement>("interceptMode");
export const armedBadge = el<HTMLSpanElement>("armedBadge");

export const queueSize = el<HTMLDivElement>("queueSize");
export const queueList = el<HTMLDivElement>("queueList");

export const reqMethod = el<HTMLInputElement>("reqMethod");
export const reqUrl = el<HTMLInputElement>("reqUrl");
export const reqHeaders = el<HTMLTextAreaElement>("reqHeaders");
export const reqBody = el<HTMLTextAreaElement>("reqBody");

export const btnForward = el<HTMLButtonElement>("btnForward");
export const btnDrop = el<HTMLButtonElement>("btnDrop");
export const btnSaveRepeater = el<HTMLButtonElement>("btnSaveRepeater");
export const btnForwardAll = el<HTMLButtonElement>("btnForwardAll");
export const btnDropAll = el<HTMLButtonElement>("btnDropAll");

export const repeaterList = el<HTMLDivElement>("repeaterList");
export const btnRefreshRepeater = el<HTMLButtonElement>("btnRefreshRepeater");

export const responseBox = el<HTMLPreElement>("responseBox");
export const editorHint = el<HTMLDivElement>("editorHint");
export const btnSaveNote = el<HTMLButtonElement>("btnSaveNote");
export const toggleSensitive = el<HTMLInputElement>("toggleSensitive");

export const scopeMode = el<HTMLSelectElement>("scopeMode");
export const bypassStatic = el<HTMLSelectElement>("bypassStatic");
export const allowDomains = el<HTMLTextAreaElement>("allowDomains");
export const allowUrlContains = el<HTMLTextAreaElement>("allowUrlContains");
export const btnLoadPolicy = el<HTMLButtonElement>("btnLoadPolicy");
export const btnSavePolicy = el<HTMLButtonElement>("btnSavePolicy");
export const btnPanicOff = el<HTMLButtonElement>("btnPanicOff");

export const notesList = el<HTMLDivElement>("notesList");
export const btnExportNotes = el<HTMLButtonElement>("btnExportNotes");
export const btnClearNotes = el<HTMLButtonElement>("btnClearNotes");

export const auditList = el<HTMLDivElement>("auditList");
export const btnRefreshAudit = el<HTMLButtonElement>("btnRefreshAudit");
export const btnClearAudit = el<HTMLButtonElement>("btnClearAudit");

export const editorReadonlyHint = el<HTMLDivElement>("editorReadonlyHint");

export const ctxMenu = el<HTMLDivElement>("ctxMenu");
export const ctxAddScope = el<HTMLDivElement>("ctxAddScope");
export const queueSearch = el<HTMLInputElement>("queueSearch");
export const noteMemo = el<HTMLInputElement>("noteMemo");
export const btnExportRepeater = el<HTMLButtonElement>("btnExportRepeater");
export const btnImportRepeater = el<HTMLInputElement>("btnImportRepeater");

export const disclaimerEl = document.getElementById("disclaimer") as HTMLDivElement | null;
export const btnDismissDisclaimer = document.getElementById("btnDismissDisclaimer") as HTMLButtonElement | null;
