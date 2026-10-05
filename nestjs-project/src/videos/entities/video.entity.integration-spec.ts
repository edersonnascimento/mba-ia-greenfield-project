import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { createTestDataSource } from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

function randSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video]);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.destroy();
  });

  async function seedChannel(): Promise<string> {
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const suffix = randSuffix();
    const user = await userRepo.save(
      userRepo.create({ email: `video-${suffix}@example.com`, password: 'x' }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'v',
        nickname: `v${suffix}`,
        user_id: user.id,
      }),
    );
    return channel.id;
  }

  it('persists a video with default draft status', async () => {
    const channelId = await seedChannel();
    const uid = `ab${randSuffix()}`;
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channelId,
        title: 'My clip',
        unique_id: uid,
        storage_key: `videos/${uid}/source.mp4`,
      }),
    );
    expect(video.id).toBeDefined();
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.created_at).toBeDefined();
    expect(video.updated_at).toBeDefined();
  });

  it('rejects a duplicate unique_id', async () => {
    const channelId = await seedChannel();
    const uid = `dup${randSuffix()}`;
    await videoRepository.save(
      videoRepository.create({
        channel_id: channelId,
        title: 'dup',
        unique_id: uid,
      }),
    );
    const second = videoRepository.create({
      channel_id: channelId,
      title: 'dup',
      unique_id: uid,
    });
    await expect(videoRepository.save(second)).rejects.toThrow();
  });

  it('rejects an invalid status enum value', async () => {
    const channelId = await seedChannel();
    const video = videoRepository.create({
      channel_id: channelId,
      title: 'bad',
      unique_id: 'bad000000001',
      status: 'nope',
    } as unknown as Video);
    await expect(videoRepository.save(video)).rejects.toThrow();
  });

  it('cascades delete when the channel is removed', async () => {
    const suffix = randSuffix();
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const user = await userRepo.save(
      userRepo.create({ email: `video-${suffix}@example.com`, password: 'x' }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'cc',
        nickname: `cc${suffix}`,
        user_id: user.id,
      }),
    );
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'cascade',
        unique_id: `cas${suffix}`,
      }),
    );

    await channelRepo.delete(channel.id);

    const after = await videoRepository.findOne({ where: { id: video.id } });
    expect(after).toBeNull();
  });
});
