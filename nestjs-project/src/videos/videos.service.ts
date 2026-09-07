import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { VideosQueue } from '../queue/videos.queue';
import { MultipartPart, StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoForbiddenException,
  VideoInvalidStatusException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoObjectVerificationFailedException,
} from './exceptions/video.exceptions';
import { baseName, extFromFilename } from './filename.util';
import { generateUniqueId } from './unique-id.util';

export interface PlaybackUrl {
  url: string;
  expires_at: Date;
}

export interface ProcessingMetadata {
  durationSeconds: number;
  width?: number;
  height?: number;
  codec?: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    private readonly videosQueue: VideosQueue,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  private async channelIdOf(userId: string): Promise<string> {
    const channel = await this.channelRepository.findOne({
      where: { user_id: userId },
    });
    if (!channel) throw new VideoForbiddenException();
    return channel.id;
  }

  private async ownedVideoOrThrow(
    videoId: string,
    channelId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.channel_id !== channelId) throw new VideoForbiddenException();
    return video;
  }

  async createDraft(userId: string, dto: CreateVideoDto): Promise<Video> {
    const channelId = await this.channelIdOf(userId);
    const uniqueId = generateUniqueId();
    const storageKey = `videos/${uniqueId}/source.${extFromFilename(dto.filename)}`;
    const video = this.videoRepository.create({
      channel_id: channelId,
      title: baseName(dto.filename),
      unique_id: uniqueId,
      storage_key: storageKey,
      content_type: dto.content_type || 'video/mp4',
      size_bytes: dto.size_bytes,
      status: VideoStatus.DRAFT,
    });
    return this.videoRepository.save(video);
  }

  async initiateUpload(
    userId: string,
    videoId: string,
  ): Promise<{ upload_id: string; key: string; part_size: number }> {
    const channelId = await this.channelIdOf(userId);
    const video = await this.ownedVideoOrThrow(videoId, channelId);
    if (video.status !== VideoStatus.DRAFT || !video.storage_key) {
      throw new VideoInvalidStatusException();
    }
    const uploadId = await this.storageService.createMultipart(
      video.storage_key,
    );
    return {
      upload_id: uploadId,
      key: video.storage_key,
      part_size: this.storageCfg.partSize,
    };
  }

  async issuePartUrl(
    userId: string,
    videoId: string,
    uploadId: string,
    partNumber: number,
  ): Promise<{ part_number: number; url: string }> {
    const channelId = await this.channelIdOf(userId);
    const video = await this.ownedVideoOrThrow(videoId, channelId);
    if (video.status !== VideoStatus.DRAFT || !video.storage_key) {
      throw new VideoInvalidStatusException();
    }
    const url = await this.storageService.presignUploadPart(
      video.storage_key,
      uploadId,
      partNumber,
    );
    return { part_number: partNumber, url };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    uploadId: string,
    parts: MultipartPart[],
    sizeBytes?: number,
  ): Promise<Video> {
    const channelId = await this.channelIdOf(userId);
    const video = await this.ownedVideoOrThrow(videoId, channelId);
    if (video.status !== VideoStatus.DRAFT || !video.storage_key) {
      throw new VideoInvalidStatusException();
    }
    await this.storageService.completeMultipart(
      video.storage_key,
      uploadId,
      parts,
    );
    const head = await this.storageService.headObject(video.storage_key);
    if (sizeBytes !== undefined && head.size !== sizeBytes) {
      throw new VideoObjectVerificationFailedException();
    }
    video.status = VideoStatus.PROCESSING;
    video.size_bytes = head.size;
    await this.videoRepository.save(video);
    await this.videosQueue.enqueueProcessing({
      videoId: video.id,
      storageKey: video.storage_key,
    });
    return video;
  }

  async abortUpload(
    userId: string,
    videoId: string,
    uploadId: string,
  ): Promise<void> {
    const channelId = await this.channelIdOf(userId);
    const video = await this.ownedVideoOrThrow(videoId, channelId);
    if (!video.storage_key) throw new VideoInvalidStatusException();
    await this.storageService.abortMultipart(video.storage_key, uploadId);
  }

  async getVideo(userId: string, videoId: string): Promise<Video> {
    const channelId = await this.channelIdOf(userId);
    return this.ownedVideoOrThrow(videoId, channelId);
  }

  async getPlayUrl(videoId: string): Promise<PlaybackUrl> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.status !== VideoStatus.READY || !video.storage_key) {
      throw new VideoNotReadyException();
    }
    const url = await this.storageService.presignGet(video.storage_key);
    return {
      url,
      expires_at: new Date(
        Date.now() + this.storageCfg.presignedUrlTtlSeconds * 1000,
      ),
    };
  }

  async getDownloadUrl(
    videoId: string,
  ): Promise<{ url: string; filename: string }> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.status !== VideoStatus.READY || !video.storage_key) {
      throw new VideoNotReadyException();
    }
    const filename = `${video.title}.mp4`;
    const url = await this.storageService.presignGet(video.storage_key, {
      disposition: `attachment; filename="${filename}"`,
    });
    return { url, filename };
  }

  async applyProcessing(
    videoId: string,
    metadata: ProcessingMetadata,
    thumbnailKey: string,
  ): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) return;
    video.status = VideoStatus.READY;
    video.duration_seconds = metadata.durationSeconds;
    video.width = metadata.width ?? null;
    video.height = metadata.height ?? null;
    video.codec = metadata.codec ?? null;
    video.thumbnail_key = thumbnailKey;
    video.processing_error = null;
    await this.videoRepository.save(video);
  }

  async markProcessedFailed(
    videoId: string,
    errorMessage: string,
  ): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) return;
    video.status = VideoStatus.FAILED;
    video.processing_error = errorMessage;
    await this.videoRepository.save(video);
  }
}
