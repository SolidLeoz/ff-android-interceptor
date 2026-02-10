import type { MessageRequest, MessageResponse, MessageType } from "../lib/types";

export const port = browser.runtime.connect({ name: "dashboard" });

export async function sendMessage<T extends MessageType>(msg: MessageRequest<T>): Promise<MessageResponse<T>> {
  return browser.runtime.sendMessage(msg) as Promise<MessageResponse<T>>;
}
