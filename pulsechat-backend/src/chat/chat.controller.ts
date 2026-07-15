import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('channels')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get()
  getMyChannels(@CurrentUser() user: { id: string }) {
    return this.chatService.getUserChannels(user.id);
  }

  @Get(':channelId/messages')
  getHistory(
    @CurrentUser() user: { id: string },
    @Param('channelId') channelId: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.chatService.getMessageHistory(channelId, user.id, cursor);
  }
}
