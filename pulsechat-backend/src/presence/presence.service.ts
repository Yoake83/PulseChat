import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export type PresenceStatus = 'online' | 'idle' | 'busy' | 'invisible' | 'offline';

const PRESENCE_KEY_PREFIX = 'presence:user:';
// If a client doesn't heartbeat within this window, treat them as offline.
const PRESENCE_TTL_SECONDS = 60;

@Injectable()
export class PresenceService {
  constructor(private readonly redis: RedisService) {}

  private key(userId: string) {
    return `${PRESENCE_KEY_PREFIX}${userId}`;
  }

  async setStatus(userId: string, status: PresenceStatus) {
    if (status === 'offline') {
      await this.redis.client.del(this.key(userId));
      return;
    }
    await this.redis.client.set(this.key(userId), status, 'EX', PRESENCE_TTL_SECONDS);
  }

  /** Called periodically by the client (or on any socket activity) to stay "online". */
  async heartbeat(userId: string) {
    const exists = await this.redis.client.exists(this.key(userId));
    if (exists) {
      await this.redis.client.expire(this.key(userId), PRESENCE_TTL_SECONDS);
    } else {
      await this.setStatus(userId, 'online');
    }
  }

  async getStatus(userId: string): Promise<PresenceStatus> {
    const status = await this.redis.client.get(this.key(userId));
    return (status as PresenceStatus) ?? 'offline';
  }

  async getBulkStatus(userIds: string[]): Promise<Record<string, PresenceStatus>> {
    if (userIds.length === 0) return {};
    const keys = userIds.map((id) => this.key(id));
    const values = await this.redis.client.mget(...keys);
    const result: Record<string, PresenceStatus> = {};
    userIds.forEach((id, idx) => {
      result[id] = (values[idx] as PresenceStatus) ?? 'offline';
    });
    return result;
  }

  async clearStatus(userId: string) {
    await this.redis.client.del(this.key(userId));
  }
}
