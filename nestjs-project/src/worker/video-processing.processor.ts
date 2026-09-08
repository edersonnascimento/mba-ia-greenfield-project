import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { VideoProcessingJobData } from '../queue/videos.queue';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';

@Processor(VIDEO_PROCESSING_QUEUE)
@Injectable()
export class VideoProcessingProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpeg: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: job.data.videoId },
    });
    if (!video) return;

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    try {
      const sourceUrl = await this.storageService.presignGet(
        job.data.storageKey,
      );
      const probe = await this.ffmpeg.probe(sourceUrl);
      const thumbBuffer = await this.ffmpeg.thumbnail(
        sourceUrl,
        probe.duration > 2 ? 1 : 0,
      );
      const thumbnailKey = `videos/${video.unique_id}/thumbnail.jpg`;
      await this.storageService.putObject(
        thumbnailKey,
        thumbBuffer,
        'image/jpeg',
      );

      video.status = VideoStatus.READY;
      video.duration_seconds = Math.round(probe.duration);
      video.width = probe.width ?? null;
      video.height = probe.height ?? null;
      video.codec = probe.codec ?? null;
      video.thumbnail_key = thumbnailKey;
      video.processing_error = null;
      await this.videoRepository.save(video);
    } catch (err) {
      const maxAttempts = job.opts?.attempts ?? 1;
      const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;
      if (isLastAttempt) {
        video.status = VideoStatus.FAILED;
        video.processing_error =
          err instanceof Error ? err.message : 'processing failed';
        await this.videoRepository.save(video);
      }
      throw err;
    }
  }
}
