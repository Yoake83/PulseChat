import { IsString, IsUUID, MinLength, MaxLength } from 'class-validator';

export class SendMessageDto {
  @IsUUID()
  channelId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content: string;
}
