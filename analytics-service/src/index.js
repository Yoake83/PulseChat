require('dotenv').config();
const { Kafka } = require('kafkajs');
const { Redis } = require('ioredis');

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const TOPIC = 'chat.messages';

const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID ?? 'analytics-service',
  brokers: KAFKA_BROKERS,
  retry: { retries: 8 },
});
const consumer = kafka.consumer({ groupId: process.env.KAFKA_GROUP_ID ?? 'analytics-service' });

const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
});

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function recordMessage(event) {
  const { channelId, senderId } = event;
  const day = todayKey();

  // A real analytics service (Phase 3+) would probably ship these to a
  // time-series store (ClickHouse/TimescaleDB) instead of Redis counters —
  // this is the "prove the event-driven wiring works" version.
  await redis
    .multi()
    .incr('analytics:messages:total')
    .incr(`analytics:messages:channel:${channelId}`)
    .incr(`analytics:messages:user:${senderId}`)
    .incr(`analytics:messages:day:${day}`)
    .sadd('analytics:active_channels', channelId)
    .exec();
}

async function logSummary() {
  const [total, today, activeChannels] = await Promise.all([
    redis.get('analytics:messages:total'),
    redis.get(`analytics:messages:day:${todayKey()}`),
    redis.scard('analytics:active_channels'),
  ]);
  console.log(
    `[analytics] total=${total ?? 0} today=${today ?? 0} active_channels=${activeChannels}`,
  );
}

async function main() {
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  console.log(`analytics-service: subscribed to "${TOPIC}", waiting for events...`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      let event;
      try {
        event = JSON.parse(message.value.toString());
      } catch {
        console.warn('analytics-service: skipping malformed message');
        return;
      }

      if (event.eventType === 'message.sent') {
        try {
          await recordMessage(event);
        } catch (err) {
          console.error('analytics-service: failed recording message', err);
        }
      }
    },
  });

  setInterval(logSummary, 10_000);
}

async function shutdown() {
  console.log('analytics-service: shutting down...');
  await consumer.disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('analytics-service: fatal error', err);
  process.exit(1);
});
