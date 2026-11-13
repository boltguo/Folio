import type { MessageDetail } from "../../shared/types";

export function replyRecipients(message: MessageDetail): string[] {
  if (message.direction === "outbound") return message.to_addresses;
  return message.reply_to_addresses.length
    ? message.reply_to_addresses
    : [message.from_address];
}
