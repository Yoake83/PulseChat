import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private readonly kafka: Kafka;
  private producer: Producer;

  constructor(private readonly config: ConfigService) {
    this.kafka = new Kafka({
      clientId: this.config.get<string>('kafka.clientId'),
      brokers: this.config.get<string[]>('kafka.brokers')!,
      retry: { retries: 5 },
    });
    this.producer = this.kafka.producer();
  }

  async onModuleInit() {
    try {
      await this.producer.connect();
      this.logger.log('Kafka producer connected');
    } catch (err) {
      // Don't crash the whole API if Kafka isn't up yet — log loudly instead.
      // Chat still works over WebSockets/Postgres; only event publishing is degraded.
      this.logger.error(`Kafka producer failed to connect: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.producer.disconnect();
  }

  /**
   * Publish an event. `key` should be the entity you want ordering guarantees
   * for (e.g. channelId) — Kafka only orders messages within the same partition,
   * and messages with the same key always land on the same partition.
   */
  async publish(topic: string, key: string, event: object) {
    try {
      await this.producer.send({
        topic,
        messages: [{ key, value: JSON.stringify(event) }],
      });
    } catch (err) {
      this.logger.error(`Failed to publish to ${topic}: ${(err as Error).message}`);
    }
  }
}
