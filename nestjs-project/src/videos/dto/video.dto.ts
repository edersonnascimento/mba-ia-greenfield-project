import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { VideoStatus } from '../entities/video.entity';

export class CreateVideoDto {
  @IsString()
  @IsNotEmpty()
  filename: string;

  @IsString()
  @IsOptional()
  content_type?: string;

  @IsNumber()
  @IsOptional()
  size_bytes?: number;
}

export class PartUrlDto {
  @IsString()
  @IsNotEmpty()
  upload_id: string;

  @IsInt()
  @Min(1)
  part_number: number;

  @IsInt()
  @Min(1)
  part_size: number;
}

export class PartItemDto {
  @IsInt()
  @Min(1)
  part_number: number;

  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @IsString()
  @IsNotEmpty()
  upload_id: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PartItemDto)
  parts: PartItemDto[];

  @IsNumber()
  @IsOptional()
  size_bytes?: number;
}

export class AbortUploadDto {
  @IsString()
  @IsNotEmpty()
  upload_id: string;
}

export class VideoDraftResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ab3xYz9Qw2Lm' })
  unique_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: string;

  @ApiProperty({ example: 'videos/Ab3xYz9Qw2Lm/source.mp4' })
  storage_key: string;
}

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ab3xYz9Qw2Lm' })
  unique_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: string;

  @ApiProperty({ required: false, nullable: true, example: '52428800' })
  size_bytes: string | number | null;

  @ApiProperty({ required: false, nullable: true })
  duration_seconds: number | null;

  @ApiProperty({ required: false, nullable: true })
  width: number | null;

  @ApiProperty({ required: false, nullable: true })
  height: number | null;

  @ApiProperty({ required: false, nullable: true })
  codec: string | null;

  @ApiProperty({ required: false, nullable: true, format: 'url' })
  thumbnail_url: string | null;

  @ApiProperty({ required: false, nullable: true, format: 'url' })
  video_url: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: Date;
}

export class PlayUrlResponseDto {
  @ApiProperty({ format: 'url' })
  url: string;

  @ApiProperty({ format: 'date-time' })
  expires_at: Date;
}
