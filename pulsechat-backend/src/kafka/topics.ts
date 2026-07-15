export const KAFKA_TOPICS = {
  CHAT_MESSAGES: 'chat.messages',
} as const;

/**
 * Event published to `chat.messages` whenever a message is persisted.
 * Keep this in sync with the shape consumed by notification-service
 * and analytics-service (see their respective `types.js`).
 */
export interface ChatMessageEvent {
  eventType: 'message.sent';
  messageId: string;
  channelId: string;
  senderId: string;
  senderUsername: string;
  content: string;
  createdAt: string; // ISO timestamp
}
