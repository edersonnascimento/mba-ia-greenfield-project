import { Logger } from '@nestjs/common';
import {
  OnQueueEvent,
  QueueEventsHost,
  QueueEventsListener,
} from '@nestjs/bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';

@QueueEventsListener(VIDEO_PROCESSING_QUEUE)
export class VideoQueueEventsListener extends QueueEventsHost {
  private readonly logger = new Logger(VideoQueueEventsListener.name);

  @OnQueueEvent('completed')
  onCompleted(job: { jobId: string }): void {
    this.logger.log(`video-processing job ${job.jobId} completed`);
  }

  @OnQueueEvent('failed')
  onFailed(job: { jobId: string; used: number }): void {
    this.logger.warn(
      `video-processing job ${job.jobId} failed (attempt ${job.used})`,
    );
  }
}
