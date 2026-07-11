import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  public client: Redis;
  public publisher: Redis;
  public subscriber: Redis;

  constructor(private readonly config: ConfigService) {
    const options = {
      host: this.config.get<string>('redis.host'),
      port: this.config.get<number>('redis.port'),
      password: this.config.get<string>('redis.password'),
    };

    // Separate connections: one for normal commands, one dedicated
    // to publishing, one dedicated to subscribing (ioredis requirement).
    this.client = new Redis(options);
    this.publisher = new Redis(options);
    this.subscriber = new Redis(options);
  }

  onModuleInit() {
    // Connections are established lazily by ioredis on first command,
    // nothing to do here explicitly.
  }

  async onModuleDestroy() {
    await Promise.all([
      this.client.quit(),
      this.publisher.quit(),
      this.subscriber.quit(),
    ]);
  }
}
