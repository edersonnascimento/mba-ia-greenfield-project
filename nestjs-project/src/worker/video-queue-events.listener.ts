import { InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import {
  OnQueueEvent,
  QueueEventsHost,
  QueueEventsListener,
} from '@nestjs/bullmq';
import type { Queue, Job } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { VideoProcessingJobData } from '../queue/videos.queue';

@QueueEventsListener(VIDEO_PROCESSING_QUEUE)
export class VideoQueueEventsListener extends QueueEventsHost {
  private readonly logger = new Logger(VideoQueueEventsListener.name);

  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
  ) {
    super();
  }

  private videoIdFrom(job: { jobId: string }): string {
    return job.jobId;
  }

  @OnQueueEvent('completed')
  async onCompleted(job: { jobId: string }): Promise<void> {
    const videoId = await this.jobVideoId(job);
    this.logger.log(
      `video-processing job ${job.jobId} completed for videoId=${videoId}`,
    );
  }

  @OnQueueEvent('failed')
  async onFailed(job: { jobId: string; failedReason: string }): Promise<void> {
    const videoId = await this.jobVideoId(job);
    this.logger.warn(
      `video-processing job ${job.jobId} failed for videoId=${videoId}: ${job.failedReason}`,
    );
  }

  private async jobVideoId(job: { jobId: string }): Promise<string | undefined> {
    let resolved: Job | null;
    try {
      resolved = await this.queue.getJob(job.jobId);
    } catch {
      return undefined;
    }
    const data = resolved?.data as Partial<VideoProcessingJobData> | undefined;
    return data?.videoId;
  }
}
