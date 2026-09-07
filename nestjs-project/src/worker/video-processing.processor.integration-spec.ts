import { Job, Queue } from 'bullmq';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingProcessor } from './video-processing.processor';

const execFile = promisify(execFileCb);

describe('VideoProcessingProcessor (integration, FFmpeg + MinIO + DB)', () => {
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let storage: StorageService;
  let processor: VideoProcessingProcessor;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video]);
    await dataSource.initialize();
    videoRepo = dataSource.getRepository(Video);

    storage = new StorageService(storageConfig());
    await storage.ensureBucket();

    processor = new VideoProcessingProcessor(
      videoRepo,
      storage,
      new FfmpegService(),
      storageConfig(),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('extracts metadata, generates a thumbnail and marks the video ready', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const tmp = await fs.mkdtemp(`${os.tmpdir()}/vid-`);
    const srcFile = path.join(tmp, 'src.mp4');
    await execFile('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x64:duration=1',
      '-pix_fmt',
      'yuv420p',
      '-y',
      srcFile,
    ]);
    const srcBuffer = await fs.readFile(srcFile);
    await fs.rm(tmp, { recursive: true, force: true });

    const uniqueId = `w${suffix}`;
    const storageKey = `videos/${uniqueId}/source.mp4`;
    await storage.putObject(storageKey, srcBuffer, 'video/mp4');

    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const user = await userRepo.save(
      userRepo.create({ email: `worker-${suffix}@example.com`, password: 'x' }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'w',
        nickname: `w${suffix}`,
        user_id: user.id,
      }),
    );
    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        title: 'ffmpeg fixture',
        unique_id: uniqueId,
        storage_key: storageKey,
        content_type: 'video/mp4',
        status: VideoStatus.PROCESSING,
      }),
    );

    const queue = new Queue(queueConfig().videoProcessingQueue, {
      connection: {
        host: queueConfig().redisHost,
        port: queueConfig().redisPort,
      },
    });
    const job = new Job(
      queue,
      queueConfig().videoProcessingQueue,
      { videoId: video.id, storageKey },
      { attempts: 3 },
    );

    try {
      await processor.process(job);

      const after = await videoRepo.findOne({ where: { id: video.id } });
      expect(after?.status).toBe(VideoStatus.READY);
      expect(after?.duration_seconds).toBeGreaterThan(0);
      expect(after?.width).toBe(64);
      expect(after?.height).toBe(64);
      expect(after?.thumbnail_key).toBe(`videos/${uniqueId}/thumbnail.jpg`);

      const thumb = await storage.headObject(after!.thumbnail_key!);
      expect(thumb.size).toBeGreaterThan(0);
    } finally {
      await queue.close();
    }
  });
});
