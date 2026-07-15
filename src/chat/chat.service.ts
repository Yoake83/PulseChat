import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelType } from '@prisma/client';
import { KafkaService } from '../kafka/kafka.service';
import { KAFKA_TOPICS, ChatMessageEvent } from '../kafka/topics';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  async createChannel(creatorId: string, memberIds: string[], name?: string) {
    const allMembers = Array.from(new Set([creatorId, ...memberIds]));
    const type: ChannelType = allMembers.length > 2 ? 'GROUP' : 'DIRECT';

    // For direct messages, reuse an existing 1:1 channel if one already exists.
    if (type === 'DIRECT') {
      const existing = await this.findExistingDirectChannel(allMembers);
      if (existing) return existing;
    }

    return this.prisma.channel.create({
      data: {
        name,
        type,
        members: {
          create: allMembers.map((userId) => ({ userId })),
        },
      },
      include: { members: true },
    });
  }

  private async findExistingDirectChannel(memberIds: string[]) {
    const candidates = await this.prisma.channel.findMany({
      where: {
        type: 'DIRECT',
        members: { every: { userId: { in: memberIds } } },
      },
      include: { members: true },
    });
    return (
      candidates.find(
        (c: { members: unknown[] }) => c.members.length === memberIds.length,
      ) ?? null
    );
  }

  async assertMembership(channelId: string, userId: string) {
    const membership = await this.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
    });
    if (!membership) throw new ForbiddenException('Not a member of this channel');
    return membership;
  }

  async getUserChannels(userId: string) {
    return this.prisma.channel.findMany({
      where: { members: { some: { userId } } },
      include: {
        members: { include: { user: { select: { id: true, username: true, avatarUrl: true } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async saveMessage(channelId: string, senderId: string, content: string) {
    await this.assertMembership(channelId, senderId);
    const message = await this.prisma.message.create({
      data: { channelId, senderId, content, status: 'SENT' },
      include: { sender: { select: { id: true, username: true, avatarUrl: true } } },
    });

    // Postgres is still the source of truth (already written above). Publishing
    // to Kafka here just fans this event out to whoever else cares — Notification
    // and Analytics services consume it independently, asynchronously.
    const event: ChatMessageEvent = {
      eventType: 'message.sent',
      messageId: message.id,
      channelId,
      senderId,
      senderUsername: message.sender.username,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    };
    await this.kafka.publish(KAFKA_TOPICS.CHAT_MESSAGES, channelId, event);

    return message;
  }

  async markDelivered(messageId: string) {
    return this.prisma.message.update({
      where: { id: messageId },
      data: { status: 'DELIVERED' },
    });
  }

  async markChannelRead(channelId: string, userId: string) {
    await this.assertMembership(channelId, userId);
    await this.prisma.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { lastReadAt: new Date() },
    });
    await this.prisma.message.updateMany({
      where: { channelId, status: { not: 'READ' } },
      data: { status: 'READ' },
    });
  }

  /** Fetch messages for offline sync: everything since the client's last known timestamp. */
  async getMessagesSince(channelId: string, userId: string, since?: Date) {
    await this.assertMembership(channelId, userId);
    return this.prisma.message.findMany({
      where: {
        channelId,
        ...(since ? { createdAt: { gt: since } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: { id: true, username: true, avatarUrl: true } } },
    });
  }

  async getMessageHistory(channelId: string, userId: string, cursor?: string, take = 30) {
    await this.assertMembership(channelId, userId);
    return this.prisma.message.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { sender: { select: { id: true, username: true, avatarUrl: true } } },
    });
  }
}
