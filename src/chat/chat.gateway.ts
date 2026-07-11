import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { PresenceService } from '../presence/presence.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CreateChannelDto, JoinChannelDto } from './dto/channel.dto';

interface AuthedSocket extends Socket {
  data: {
    user: { id: string; email: string; username: string };
  };
}

@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? '*', credentials: true },
  namespace: '/chat',
})
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly presenceService: PresenceService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async handleConnection(client: AuthedSocket) {
    try {
      const token = this.extractToken(client);
      if (!token) throw new Error('missing token');

      const payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
      });
      client.data.user = {
        id: payload.sub,
        email: payload.email,
        username: payload.username,
      };
    } catch {
      client.emit('error', { message: 'Authentication failed' });
      client.disconnect(true);
      return;
    }

    const userId = client.data.user.id;

    // Personal room lets us push notifications to a user regardless of which
    // channel-specific rooms they've joined (e.g. "you were added to a group").
    await client.join(this.personalRoom(userId));

    const channels = await this.chatService.getUserChannels(userId);
    for (const channel of channels) {
      await client.join(this.channelRoom(channel.id));
    }

    await this.presenceService.setStatus(userId, 'online');
    this.server.emit('presence:update', { userId, status: 'online' });

    this.logger.log(`User ${client.data.user.username} connected (${client.id})`);
  }

  async handleDisconnect(client: AuthedSocket) {
    const user = client.data?.user;
    if (!user) return;

    await this.presenceService.clearStatus(user.id);
    this.server.emit('presence:update', { userId: user.id, status: 'offline' });
    this.logger.log(`User ${user.username} disconnected (${client.id})`);
  }

  @SubscribeMessage('heartbeat')
  async onHeartbeat(@ConnectedSocket() client: AuthedSocket) {
    await this.presenceService.heartbeat(client.data.user.id);
  }

  @SubscribeMessage('presence:set')
  async onSetPresence(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { status: 'online' | 'idle' | 'busy' | 'invisible' },
  ) {
    const userId = client.data.user.id;
    await this.presenceService.setStatus(userId, body.status);
    this.server.emit('presence:update', { userId, status: body.status });
  }

  @SubscribeMessage('channel:create')
  async onCreateChannel(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: CreateChannelDto,
  ) {
    const channel = await this.chatService.createChannel(
      client.data.user.id,
      dto.memberIds,
      dto.name,
    );

    // Bring every currently-connected member into the room so they get
    // real-time updates without needing to reconnect.
    const memberSockets = await this.server.fetchSockets();
    for (const socket of memberSockets) {
      const socketUser = (socket.data as AuthedSocket['data'])?.user;
      if (
        socketUser &&
        channel.members.some((m: { userId: string }) => m.userId === socketUser.id)
      ) {
        socket.join(this.channelRoom(channel.id));
      }
    }

    this.server.to(this.channelRoom(channel.id)).emit('channel:created', channel);
    return channel;
  }

  @SubscribeMessage('channel:join')
  async onJoinChannel(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: JoinChannelDto,
  ) {
    await this.chatService.assertMembership(dto.channelId, client.data.user.id);
    await client.join(this.channelRoom(dto.channelId));
    return { joined: dto.channelId };
  }

  @SubscribeMessage('message:send')
  async onSendMessage(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: SendMessageDto,
  ) {
    const message = await this.chatService.saveMessage(
      dto.channelId,
      client.data.user.id,
      dto.content,
    );

    this.server.to(this.channelRoom(dto.channelId)).emit('message:new', message);
    return message;
  }

  @SubscribeMessage('message:typing')
  onTyping(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { channelId: string; isTyping: boolean },
  ) {
    client.to(this.channelRoom(body.channelId)).emit('message:typing', {
      channelId: body.channelId,
      userId: client.data.user.id,
      username: client.data.user.username,
      isTyping: body.isTyping,
    });
  }

  @SubscribeMessage('message:read')
  async onMarkRead(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { channelId: string },
  ) {
    await this.chatService.markChannelRead(body.channelId, client.data.user.id);
    this.server.to(this.channelRoom(body.channelId)).emit('message:read', {
      channelId: body.channelId,
      userId: client.data.user.id,
    });
  }

  /** Offline sync: client reconnects and asks for everything since its last known message. */
  @SubscribeMessage('sync')
  async onSync(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { channelId: string; since?: string },
  ) {
    const since = body.since ? new Date(body.since) : undefined;
    return this.chatService.getMessagesSince(body.channelId, client.data.user.id, since);
  }

  private personalRoom(userId: string) {
    return `user:${userId}`;
  }

  private channelRoom(channelId: string) {
    return `channel:${channelId}`;
  }

  private extractToken(client: Socket): string | undefined {
    const authToken = client.handshake.auth?.token as string | undefined;
    if (authToken) return authToken;
    const header = client.handshake.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);
    return undefined;
  }
}
