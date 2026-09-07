import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import {
  AbortUploadDto,
  CompleteUploadDto,
  CreateVideoDto,
  PartUrlDto,
} from './dto/video.dto';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Pre-register a video draft',
    description:
      'Creates the video as a draft and returns its storage key, so a presigned multipart upload session can start.',
  })
  async createDraft(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<Video> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Post(':id/uploads')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a multipart upload session',
    description:
      'Creates the multipart session on object storage and returns the upload id, key and part size.',
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<{ upload_id: string; key: string; part_size: number }> {
    return this.videosService.initiateUpload(user.sub, id);
  }

  @Post(':id/uploads/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Issue a presigned upload-part URL',
    description:
      'Returns a presigned URL for one part; the client streams the part bytes directly to object storage.',
  })
  async issuePartUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: PartUrlDto,
  ): Promise<{ part_number: number; url: string }> {
    return this.videosService.issuePartUrl(
      user.sub,
      id,
      dto.upload_id,
      dto.part_number,
    );
  }

  @Post(':id/uploads/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the multipart upload',
    description:
      'Completes the multipart upload, verifies the object and enqueues background processing.',
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; status: string }> {
    const video = await this.videosService.completeUpload(
      user.sub,
      id,
      dto.upload_id,
      dto.parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
      dto.size_bytes,
    );
    return { id: video.id, status: video.status };
  }

  @Post(':id/uploads/abort')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort the multipart upload',
    description:
      'Aborts an in-flight multipart upload so the draft can be re-uploaded.',
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: AbortUploadDto,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, id, dto.upload_id);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get video detail (owner)',
    description: 'Returns the video metadata for its channel owner.',
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<Video> {
    return this.videosService.getVideo(user.sub, id);
  }

  @Get(':id/play-url')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get a presigned streaming URL',
    description:
      'Returns a presigned object URL that streams via HTTP Range requests; anonymous access is allowed.',
  })
  async playUrl(
    @Param('id') id: string,
  ): Promise<{ url: string; expires_at: Date }> {
    return this.videosService.getPlayUrl(id);
  }

  @Get(':id/download-url')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get a presigned download URL',
    description:
      'Returns a presigned URL that triggers a file download (Content-Disposition: attachment).',
  })
  async downloadUrl(
    @Param('id') id: string,
  ): Promise<{ url: string; filename: string }> {
    return this.videosService.getDownloadUrl(id);
  }
}
