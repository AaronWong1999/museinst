



import type { Channel } from "../env";

export type MediaKind = "text" | "image" | "voice" | "file" | "video" | "sticker" | "location";

export interface ChannelEvent {
  channel: Channel;

  senderId: string;

  botId?: string;

  groupChatId?: string;

  contextToken?: string;
  messageId: string;

  replyToMessageId?: string;
  kind: MediaKind;
  text?: string;
  emailSubject?: string;

  mediaNote?: string;

  location?: { lat: number; lng: number; accuracy?: number; live: boolean };

  voiceFileId?: string;
  receivedAt: number;
}


export interface ChannelReplyOptions {
  replyToMessageId?: string;
  disablePreview?: boolean;
}

export interface ChannelReply {
  reply(text: string, options?: ChannelReplyOptions): Promise<void>;

  typing(on: boolean): Promise<void>;

  react?(type: string, op?: "add" | "remove"): Promise<void>;
}

export function textEvent(
  channel: Channel,
  senderId: string,
  messageId: string,
  text: string,
  contextToken?: string,
): ChannelEvent {
  return {
    channel,
    senderId,
    messageId,
    kind: "text",
    text,
    contextToken,
    receivedAt: Date.now(),
  };
}
