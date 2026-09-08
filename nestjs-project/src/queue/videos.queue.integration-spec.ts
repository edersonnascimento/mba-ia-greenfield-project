import * as crypto from 'crypto';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_JOB_PREFIX } from './queue.constants';
import { VideosQueue } from './videos.queue';

describe('VideosQueue (integration, Redis)', () => {
  const cfg = queueConfig();
  let queue: Queue;
  let videosQueue: VideosQueue;

  beforeAll(() => {
    queue = new Queue(cfg.videoProcessingQueue, {
      connection: { host: cfg.redisHost, port: cfg.redisPort },
    });
    videosQueue = new VideosQueue(queue, cfg);
  });

  beforeEach(async () => {
    await queue.drain();
  });

  afterAll(async () => {
    await queue.drain();
    await queue.close();
  });

  it('lands a job on the video-processing queue with the retry options', async () => {
    const videoId = crypto.randomUUID();
    const storageKey = `videos/abc-${videoId.slice(0, 8)}/source.mp4`;

    const jobId = await videosQueue.enqueueProcessing({ videoId, storageKey });

    expect(jobId).toBe(`${VIDEO_PROCESSING_JOB_PREFIX}-${videoId}`);
    const job = await queue.getJob(jobId);
    expect(job).not.toBeNull();
    expect(job?.data).toMatchObject({ videoId, storageKey });
    expect(job?.opts.attempts).toBe(cfg.attempts);
  });

  it('does not duplicate a job for the same videoId', async () => {
    const videoId = crypto.randomUUID();
    const data = { videoId, storageKey: 'videos/abc/source.mp4' };

    await videosQueue.enqueueProcessing(data);
    await videosQueue.enqueueProcessing(data);

    const jobs = await queue.getJobs();
    const matches = jobs.filter((j) => j.id === `video-${videoId}`);
    expect(matches).toHaveLength(1);
  });
});