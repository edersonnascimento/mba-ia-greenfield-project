import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  VIDEO_PROCESSING_JOB_PREFIX,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';

export interface VideoProcessingJobData {
  videoId: string;
  storageKey: string;
}

@Injectable()
export class VideosQueue {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
    @Inject(queueConfig.KEY)
    private readonly cfg: ConfigType<typeof queueConfig>,
  ) {}

  async enqueueProcessing(data: VideoProcessingJobData): Promise<string> {
    const job = await this.queue.add(VIDEO_PROCESSING_QUEUE, data, {
      jobId: `${VIDEO_PROCESSING_JOB_PREFIX}-${data.videoId}`,
      attempts: this.cfg.attempts,
      backoff: { type: 'exponential', delay: 2000 },
    });
    return job.id ?? '';
  }
}
