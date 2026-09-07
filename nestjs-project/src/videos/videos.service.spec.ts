import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { VideosQueue } from '../queue/videos.queue';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoForbiddenException,
  VideoInvalidStatusException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoObjectVerificationFailedException,
} from './exceptions/video.exceptions';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let channelRepository: { findOne: jest.Mock };
  let storageService: {
    createMultipart: jest.Mock;
    completeMultipart: jest.Mock;
    headObject: jest.Mock;
    presignUploadPart: jest.Mock;
    presignGet: jest.Mock;
    putObject: jest.Mock;
  };
  let videosQueue: { enqueueProcessing: jest.Mock };

  const cfg = storageConfig();

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
    };
    channelRepository = { findOne: jest.fn() };
    storageService = {
      createMultipart: jest.fn(),
      completeMultipart: jest.fn(),
      headObject: jest.fn(),
      presignUploadPart: jest.fn(),
      presignGet: jest.fn(),
      putObject: jest.fn(),
    };
    videosQueue = { enqueueProcessing: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: getRepositoryToken(Channel), useValue: channelRepository },
        { provide: StorageService, useValue: storageService },
        { provide: VideosQueue, useValue: videosQueue },
        { provide: storageConfig.KEY, useValue: cfg },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  function ownerSetup() {
    channelRepository.findOne.mockResolvedValue({ id: 'channel-1' });
  }

  describe('createDraft', () => {
    it('creates a draft video with storage key and unique id', async () => {
      ownerSetup();
      videoRepository.create.mockImplementation((data: Video) => data);
      videoRepository.save.mockImplementation((data: Video) =>
        Promise.resolve(data),
      );

      const dto: CreateVideoDto = {
        filename: 'clip.mp4',
        content_type: 'video/mp4',
      };
      const video = await service.createDraft('user-1', dto);

      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.channel_id).toBe('channel-1');
      expect(video.unique_id).toMatch(/^[A-Za-z0-9]{1,12}$/);
      expect(video.storage_key).toBe(`videos/${video.unique_id}/source.mp4`);
      expect(video.title).toBe('clip');
    });
  });

  describe('ownership and status guards', () => {
    const loadVideo = (overrides: Partial<Video> = {}) =>
      ({
        id: 'v-1',
        channel_id: 'channel-1',
        status: VideoStatus.DRAFT,
        storage_key: 'videos/abc/source.mp4',
        unique_id: 'abc',
        title: 'clip',
        ...overrides,
      }) as Video;

    beforeEach(() => ownerSetup());

    it('initiateUpload throws 404 for missing video', async () => {
      videoRepository.findOne.mockResolvedValue(null);
      await expect(service.initiateUpload('user-1', 'missing')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('initiateUpload throws 403 for non-owner', async () => {
      videoRepository.findOne.mockResolvedValue(
        loadVideo({ channel_id: 'channel-other' }),
      );
      await expect(service.initiateUpload('user-1', 'v-1')).rejects.toThrow(
        VideoForbiddenException,
      );
    });

    it('initiateUpload throws 409 when status is not draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        loadVideo({ status: VideoStatus.PROCESSING }),
      );
      await expect(service.initiateUpload('user-1', 'v-1')).rejects.toThrow(
        VideoInvalidStatusException,
      );
    });

    it('initiateUpload creates a multipart session on draft', async () => {
      videoRepository.findOne.mockResolvedValue(loadVideo());
      storageService.createMultipart.mockResolvedValue('upload-xyz');
      const result = await service.initiateUpload('user-1', 'v-1');
      expect(result.upload_id).toBe('upload-xyz');
      expect(result.part_size).toBe(cfg.partSize);
    });
  });

  describe('completeUpload', () => {
    const loadVideo = () =>
      ({
        id: 'v-1',
        channel_id: 'channel-1',
        status: VideoStatus.DRAFT,
        storage_key: 'videos/abc/source.mp4',
        unique_id: 'abc',
        title: 'clip',
      }) as Video;

    beforeEach(() => ownerSetup());

    it('verifies size mismatch and throws', async () => {
      videoRepository.findOne.mockResolvedValue(loadVideo());
      videoRepository.save.mockImplementation((d) => Promise.resolve(d));
      storageService.headObject.mockResolvedValue({ size: 999 });
      await expect(
        service.completeUpload('user-1', 'v-1', 'up', [], 1000),
      ).rejects.toThrow(VideoObjectVerificationFailedException);
    });

    it('transitions to processing and enqueues on success', async () => {
      videoRepository.findOne.mockResolvedValue(loadVideo());
      videoRepository.save.mockImplementation((d) => Promise.resolve(d));
      storageService.completeMultipart.mockResolvedValue(undefined);
      storageService.headObject.mockResolvedValue({ size: 512 });
      videosQueue.enqueueProcessing.mockResolvedValue('job-x');

      const video = await service.completeUpload(
        'user-1',
        'v-1',
        'up',
        [{ partNumber: 1, etag: 'etag-1' }],
        512,
      );

      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(video.size_bytes).toBe(512);
      expect(videosQueue.enqueueProcessing).toHaveBeenCalledWith({
        videoId: 'v-1',
        storageKey: 'videos/abc/source.mp4',
      });
    });
  });

  describe('playUrl / downloadUrl', () => {
    it('getPlayUrl throws 409 when not ready', async () => {
      videoRepository.findOne.mockResolvedValue({ status: 'draft' } as any);
      await expect(service.getPlayUrl('v-1')).rejects.toThrow(
        VideoNotReadyException,
      );
    });
  });
});
