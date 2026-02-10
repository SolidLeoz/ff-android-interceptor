import type { HttpResponse, InterceptMode, ReplayRequest, RequestEntry } from "../lib/types";

export type ForwardResponse =
  | { ok: true; response: HttpResponse }
  | { ok: false; error: string; durationMs?: number };

export interface UiState {
  currentMode: InterceptMode;
  currentId: string | null;
  currentEntry: RequestEntry | null;
  lastForwardedRequest: ReplayRequest | null;
  lastForwardedResponse: ForwardResponse | null;
  showSensitive: boolean;
  cachedQueue: RequestEntry[];
  ctxTarget: RequestEntry | null;
}

export const uiState: UiState = {
  currentMode: "OFF",
  currentId: null,
  currentEntry: null,
  lastForwardedRequest: null,
  lastForwardedResponse: null,
  showSensitive: false,
  cachedQueue: [],
  ctxTarget: null,
};
