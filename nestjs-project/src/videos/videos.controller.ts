import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import {
  AbortUploadDto,
  CompleteUploadDto,
  CreateVideoDto,
  PartUrlDto,
  PlayUrlResponseDto,
  VideoDraftResponseDto,
  VideoResponseDto,
} from './dto/video.dto';
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
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Draft pre-registered successfully',
    type: VideoDraftResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'User has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createDraft(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<VideoDraftResponseDto> {
    const video = await this.videosService.createDraft(user.sub, dto);
    return {
      id: video.id,
      unique_id: video.unique_id,
      title: video.title,
      status: video.status,
      storage_key: video.storage_key ?? '',
    };
  }

  @Post(':id/uploads')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a multipart upload session',
    description:
      'Creates the multipart session on object storage and returns the upload id, key and part size.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Multipart session initiated',
    schema: {
      properties: {
        upload_id: { type: 'string' },
        key: { type: 'string' },
        part_size: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You do not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Video is in an invalid status for this operation',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
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
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Presigned part URL issued',
    schema: {
      properties: {
        part_number: { type: 'number' },
        url: { type: 'string', format: 'url' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You do not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Video is in an invalid status for this operation',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
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
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Upload completed; video moves to processing',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You do not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'Video is in an invalid status or the uploaded object does not match the expected size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
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
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: 'Aborted' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You do not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
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
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Video detail',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You do not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<VideoResponseDto> {
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
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Presigned streaming URL',
    type: PlayUrlResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async playUrl(@Param('id') id: string): Promise<PlayUrlResponseDto> {
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
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Presigned download URL',
    schema: {
      properties: {
        url: { type: 'string', format: 'url' },
        filename: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async downloadUrl(
    @Param('id') id: string,
  ): Promise<{ url: string; filename: string }> {
    return this.videosService.getDownloadUrl(id);
  }
}
