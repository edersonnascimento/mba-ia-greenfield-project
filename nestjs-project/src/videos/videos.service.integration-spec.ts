import * as crypto from 'crypto';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { VideosQueue } from '../queue/videos.queue';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const MIN_PART = 5 * 1024 * 1024;

describe('VideosService (integration, MinIO + Redis + DB)', () => {
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let channelRepo: Repository<Channel>;
  let storage: StorageService;
  let queue: Queue;
  let service: VideosService;
  let userId: string;
  let channelId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video]);
    await dataSource.initialize();
    videoRepo = dataSource.getRepository(Video);
    channelRepo = dataSource.getRepository(Channel);

    const suffix = crypto.randomUUID().slice(0, 8);
    const userRepo = dataSource.getRepository(User);
    const user = await userRepo.save(
      userRepo.create({ email: `vint-${suffix}@example.com`, password: 'x' }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'vint',
        nickname: `vint${suffix}`,
        user_id: user.id,
      }),
    );
    userId = user.id;
    channelId = channel.id;

    storage = new StorageService(storageConfig());
    await storage.ensureBucket();

    queue = new Queue(queueConfig().videoProcessingQueue, {
      connection: {
        host: queueConfig().redisHost,
        port: queueConfig().redisPort,
      },
    });
    await queue.drain();
    const videosQueue = new VideosQueue(queue, queueConfig());
    service = new VideosService(
      videoRepo,
      channelRepo,
      storage,
      videosQueue,
      storageConfig(),
    );
  });

  afterAll(async () => {
    await queue.drain();
    await queue.close();
    await dataSource.destroy();
  });

  async function uploadDraft(
    filename = `clip-${crypto.randomUUID().slice(0, 6)}.mp4`,
  ) {
    const video = await service.createDraft(userId, {
      filename,
      content_type: 'video/mp4',
    });
    const session = await service.initiateUpload(userId, video.id);
    const parts: { partNumber: number; etag: string }[] = [];

    const part = Buffer.alloc(MIN_PART);
    part.fill(65);
    const { url } = await service.issuePartUrl(
      userId,
      video.id,
      session.upload_id,
      1,
    );
    const res = await fetch(url, { method: 'PUT', body: part });
    expect(res.ok).toBe(true);
    parts.push({ partNumber: 1, etag: res.headers.get('etag') ?? '' });

    return { video, session, parts };
  }

  it('creates a draft, uploads via presigned parts, completes and enqueues', async () => {
    const { video, session, parts } = await uploadDraft();
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.channel_id).toBe(channelId);

    const completed = await service.completeUpload(
      userId,
      video.id,
      session.upload_id,
      parts,
    );
    expect(completed.status).toBe(VideoStatus.PROCESSING);
    expect(completed.size_bytes).toBe(MIN_PART);

    const job = await queue.getJob(`video-${completed.id}`);
    if (!job) throw new Error('processing job was not enqueued');
    const jobData = job.data as { videoId: string };
    expect(jobData.videoId).toBe(completed.id);
  });

  it('throws VIDEO_FORBIDDEN for a non-owner user', async () => {
    const { video } = await uploadDraft();
    await expect(
      service.initiateUpload(userId + 'x', video.id),
    ).rejects.toThrow();
  });

  it('aborts the upload session', async () => {
    const { video, session } = await uploadDraft();
    await service.abortUpload(userId, video.id, session.upload_id);
    // The draft remains re-uploadable
    expect(video.status).toBe(VideoStatus.DRAFT);
  });
});
