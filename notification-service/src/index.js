require('dotenv').config();
const { Kafka } = require('kafkajs');
const { Redis } = require('ioredis');
const { Pool } = require('pg');

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const TOPIC = 'chat.messages';

const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID ?? 'notification-service',
  brokers: KAFKA_BROKERS,
  retry: { retries: 8 },
});
const consumer = kafka.consumer({ groupId: process.env.KAFKA_GROUP_ID ?? 'notification-service' });

const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function getOtherChannelMembers(channelId, senderId) {
  const { rows } = await pool.query(
    'SELECT "userId" FROM "ChannelMember" WHERE "channelId" = $1 AND "userId" != $2',
    [channelId, senderId],
  );
  return rows.map((r) => r.userId);
}

async function isOnline(userId) {
  const status = await redis.get(`presence:user:${userId}`);
  return status !== null;
}

async function handleMessageSent(event) {
  const { messageId, channelId, senderId, senderUsername, content } = event;
  const memberIds = await getOtherChannelMembers(channelId, senderId);

  for (const userId of memberIds) {
    const online = await isOnline(userId);
    if (online) {
      // They have an active socket connection — the gateway already delivered
      // the message to them in real time. Nothing to do here.
      continue;
    }

    // Offline: bump their unread-notification counter. A real push provider
    // (FCM/APNs/web-push) would be called here too — logged as a stand-in.
    const key = `notifications:unread:${userId}`;
    const unreadCount = await redis.incr(key);

    console.log(
      `[notify] user=${userId} is offline — unread count now ${unreadCount}. ` +
        `Would push: "${senderUsername}: ${content}" (message ${messageId}, channel ${channelId})`,
    );
  }
}

async function main() {
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  console.log(`notification-service: subscribed to "${TOPIC}", waiting for events...`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      let event;
      try {
        event = JSON.parse(message.value.toString());
      } catch {
        console.warn('notification-service: skipping malformed message');
        return;
      }

      if (event.eventType === 'message.sent') {
        try {
          await handleMessageSent(event);
        } catch (err) {
          console.error('notification-service: failed handling message.sent', err);
        }
      }
    },
  });
}

async function shutdown() {
  console.log('notification-service: shutting down...');
  await consumer.disconnect();
  await pool.end();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('notification-service: fatal error', err);
  process.exit(1);
});
