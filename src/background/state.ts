import type { InterceptMode, PassthroughEntry, RequestEntry } from "../lib/types";

export const RETENTION = {
  notes: 200,
  repeater: 50,
  audit: 500,
};

export const OBSERVE_QUEUE_MAX = 100;

export interface BackgroundState {
  interceptMode: InterceptMode;
  pending: Map<string, RequestEntry>;
  queue: string[];
  ports: Set<browser.runtime.Port>;
  passthrough: Map<number, PassthroughEntry>;
  passthroughTimers: Map<number, number>;
  maxBodyCaptureBytes: number;
  maxResponseBytes: number;
}

export const state: BackgroundState = {
  interceptMode: "OFF",
  pending: new Map(),
  queue: [],
  ports: new Set(),
  passthrough: new Map(),
  passthroughTimers: new Map(),
  maxBodyCaptureBytes: 1024 * 256,
  maxResponseBytes: 1024 * 512,
};
