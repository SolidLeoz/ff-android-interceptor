export type InterceptMode = "OFF" | "OBSERVE" | "INTERCEPT";
export type ScopeMode = "ALLOWLIST" | "OFF";

export interface Policy {
  scopeMode: ScopeMode;
  allowDomains: string[];
  allowUrlContains: string[];
  bypassStaticAssets: boolean;
  bypassTypes: string[];
  bypassOptions: boolean;
}

export type RequestBody =
  | {
      kind: "raw_base64" | "raw_base64_truncated";
      bytesBase64: string;
      originalBytes: number;
      capturedBytes: number;
    }
  | {
      kind: "formData";
      formData: Record<string, string[]>;
    }
  | {
      kind: "text";
      text: string;
    };

export interface ResponseBody {
  kind: "raw_base64";
  bytesBase64: string;
  originalBytes: number;
  capturedBytes: number;
  truncated: boolean;
}

export interface HttpResponse {
  ok: boolean;
  error?: string;
  durationMs: number;
  status?: number;
  statusText?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: ResponseBody;
  note?: string;
}

export type WrappedResponse =
  | { ok: true; response: HttpResponse }
  | { ok: false; error: string; durationMs?: number };

export interface ReplayRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: RequestBody | null;
}

export interface RepeaterItem {
  id?: string;
  name: string;
  request: ReplayRequest;
  savedAt?: string;
}

export interface NoteEntry {
  id: string;
  timestamp: string;
  memo: string;
  request: ReplayRequest | null;
  response: WrappedResponse | null;
}

export interface AuditEntry {
  timestamp: string;
  action: string;
  method?: string;
  url?: string;
  mode?: InterceptMode;
  scopeMode?: string;
  count?: number;
  requestId?: string;
}

export interface RequestEntry {
  id: string;
  time: string;
  tabId: number;
  frameId: number;
  type: string;
  method: string;
  url: string;
  requestBody: RequestBody | null;
  bodyHint: string | null;
  headers: Record<string, string> | null;
  observe: boolean;
  capturedFrom: string;
  note: string;
  editedHeaders?: Record<string, string>;
  capturedResponse?: ArrayBuffer;
  capturedStatus?: number;
  capturedStatusText?: string;
  capturedResponseHeaders?: Record<string, string>;
  holdResolve?: (response: browser.webRequest.BlockingResponse) => void;
  holdTimer?: number;
}

export interface PassthroughEntry {
  url: string;
  time: number;
  mainFrameDone?: boolean;
  mainFrameTime?: number;
}

export type PortMessage =
  | {
      type: "INIT";
      payload: {
        interceptMode: InterceptMode;
        queue: RequestEntry[];
        policy: Policy;
      };
    }
  | {
      type: "QUEUE_UPDATED";
      payload: {
        interceptMode: InterceptMode;
        size: number;
      };
    }
  | {
      type: "REQUEST_INTERCEPTED";
      payload: { entry: RequestEntry };
    }
  | {
      type: "REQUEST_UPDATED";
      payload: { id: string; patch: Partial<RequestEntry> };
    }
  | {
      type: "RESPONSE_CAPTURED";
      payload: { id: string };
    }
  | {
      type: "POLICY_UPDATED";
      payload: { policy: Policy };
    };

export interface MessageMap {
  OPEN_DASHBOARD: {
    request: {};
    response: { ok: true } | { ok: false; error: string };
  };
  TOGGLE_INTERCEPT: {
    request: { mode?: InterceptMode; enabled?: boolean };
    response:
      | { ok: true; interceptMode: InterceptMode }
      | { ok: false; error: string };
  };
  GET_QUEUE: {
    request: {};
    response:
      | { ok: true; interceptMode: InterceptMode; queue: RequestEntry[] }
      | { ok: false; error: string };
  };
  DROP_REQUEST: {
    request: { id: string };
    response: { ok: true } | { ok: false; error: string };
  };
  FORWARD_REQUEST: {
    request: { id: string; edited: { url?: string; headers?: Record<string, string> } };
    response:
      | { ok: true; response: HttpResponse }
      | { ok: false; error: string };
  };
  DROP_ALL: {
    request: {};
    response: { ok: true } | { ok: false; error: string };
  };
  FORWARD_ALL: {
    request: {};
    response:
      | { ok: true; forwarded: number; failed: number }
      | { ok: false; error: string };
  };
  SAVE_REPEATER_ITEM: {
    request: { item: RepeaterItem };
    response: { ok: true; count: number } | { ok: false; error: string };
  };
  LIST_REPEATER_ITEMS: {
    request: {};
    response: { ok: true; items: RepeaterItem[] } | { ok: false; error: string };
  };
  RUN_REPEATER_ITEM: {
    request: { request: ReplayRequest };
    response: { ok: true; response: HttpResponse } | { ok: false; error: string };
  };
  DELETE_REPEATER_ITEM: {
    request: { id: string };
    response: { ok: true; count: number } | { ok: false; error: string };
  };
  GET_POLICY: {
    request: {};
    response: { ok: true; policy: Policy } | { ok: false; error: string };
  };
  SET_POLICY: {
    request: { policy: Partial<Policy> };
    response: { ok: true; policy: Policy } | { ok: false; error: string };
  };
  SAVE_NOTE: {
    request: { memo?: string; request?: ReplayRequest | null; response?: WrappedResponse | null };
    response: { ok: true; count: number } | { ok: false; error: string };
  };
  LIST_NOTES: {
    request: {};
    response: { ok: true; notes: NoteEntry[] } | { ok: false; error: string };
  };
  DELETE_NOTE: {
    request: { id: string };
    response: { ok: true; count: number } | { ok: false; error: string };
  };
  CLEAR_NOTES: {
    request: {};
    response: { ok: true } | { ok: false; error: string };
  };
  LIST_AUDIT_LOG: {
    request: {};
    response: { ok: true; log: AuditEntry[] } | { ok: false; error: string };
  };
  CLEAR_AUDIT_LOG: {
    request: {};
    response: { ok: true } | { ok: false; error: string };
  };
}

export type MessageType = keyof MessageMap;
export type MessageRequest<T extends MessageType = MessageType> = { type: T } &
  MessageMap[T]["request"];
export type MessageResponse<T extends MessageType = MessageType> = MessageMap[T]["response"];
