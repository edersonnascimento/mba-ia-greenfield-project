import queueConfig from '../config/queue.config';
import { VideosQueue } from './videos.queue';

describe('VideosQueue', () => {
  let queue: { add: jest.Mock };

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
  });

  function makeQueue() {
    return new VideosQueue(queue as any, queueConfig());
  }

  it('enqueues a processing job with retry options', async () => {
    const svc = makeQueue();
    const jobId = await svc.enqueueProcessing({
      videoId: 'v-1',
      storageKey: 'videos/abc/source.mp4',
    });

    expect(jobId).toBe('job-1');
    expect(queue.add).toHaveBeenCalledWith(
      'video-processing',
      { videoId: 'v-1', storageKey: 'videos/abc/source.mp4' },
      expect.objectContaining({
        jobId: 'video-v-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      }),
    );
  });
});
