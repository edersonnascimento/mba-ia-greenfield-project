import { Job } from 'bullmq';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingProcessor } from './video-processing.processor';

const cfg = storageConfig();

function makeRepo(video: Video | null) {
  const save = jest.fn().mockImplementation((v: Video) => Promise.resolve(v));
  return {
    findOne: jest.fn().mockResolvedValue(video),
    save,
  };
}

function makeStorage() {
  return {
    presignGet: jest.fn().mockResolvedValue('https://presigned/source.mp4'),
    putObject: jest.fn().mockResolvedValue(undefined) as jest.Mock,
  };
}

function makeFfmpeg(
  probe: ReturnType<typeof jest.fn>,
  thumbnail: ReturnType<typeof jest.fn>,
) {
  return { probe, thumbnail };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    data: { videoId: 'v-1', storageKey: 'videos/abc/source.mp4' },
    opts: { attempts: 3 },
    attemptsMade: 0,
    ...overrides,
  } as unknown as Job;
}

describe('VideoProcessingProcessor (unit)', () => {
  let repo: ReturnType<typeof makeRepo>;
  let storage: ReturnType<typeof makeStorage>;
  let ffmpeg: ReturnType<typeof makeFfmpeg>;
  let processor: VideoProcessingProcessor;

  beforeEach(() => {
    const video = {
      id: 'v-1',
      unique_id: 'abc',
      status: VideoStatus.PROCESSING,
    } as Video;
    repo = makeRepo(video);
    storage = makeStorage();
    const probe = jest.fn().mockResolvedValue({
      duration: 12.5,
      width: 1920,
      height: 1080,
      codec: 'h264',
    });
    const thumbnail = jest.fn().mockResolvedValue(Buffer.from('thumb'));
    ffmpeg = makeFfmpeg(probe, thumbnail);
    processor = new VideoProcessingProcessor(
      repo as unknown as VideoProcessingProcessor['videoRepository'],
      storage as unknown as StorageService,
      ffmpeg as unknown as FfmpegService,
    );
  });

  it('probes, generates a thumbnail and marks the video ready', async () => {
    await processor.process(makeJob());

    expect(ffmpeg.probe).toHaveBeenCalledWith('https://presigned/source.mp4');
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/abc/thumbnail.jpg',
      Buffer.from('thumb'),
      'image/jpeg',
    );

    const saved = repo.save.mock.calls.at(-1)[0] as Video;
    expect(saved.status).toBe(VideoStatus.READY);
    expect(saved.duration_seconds).toBe(13);
    expect(saved.width).toBe(1920);
    expect(saved.height).toBe(1080);
    expect(saved.codec).toBe('h264');
    expect(saved.thumbnail_key).toBe('videos/abc/thumbnail.jpg');
    expect(saved.processing_error).toBeNull();
  });

  it('uses seek 0 for short clips (duration <= 2)', async () => {
    (ffmpeg.probe as jest.Mock).mockResolvedValue({
      duration: 1.5,
      width: 1,
      height: 1,
      codec: 'mpeg4',
    });
    await processor.process(makeJob());
    expect(ffmpeg.thumbnail).toHaveBeenCalledWith(
      'https://presigned/source.mp4',
      0,
    );
  });

  it('marks the video failed and rethrows on the final BullMQ attempt', async () => {
    (ffmpeg.probe as jest.Mock).mockRejectedValue(new Error('probe failed'));
    const job = makeJob({ attemptsMade: 2 });

    await expect(processor.process(job)).rejects.toThrow('probe failed');

    const saved = repo.save.mock.calls.at(-1)[0] as Video;
    expect(saved.status).toBe(VideoStatus.FAILED);
    expect(saved.processing_error).toBe('probe failed');
  });

  it('does not mark failed before exhausting retries', async () => {
    (ffmpeg.probe as jest.Mock).mockRejectedValue(new Error('boom'));
    const job = makeJob({ attemptsMade: 0 });

    await expect(processor.process(job)).rejects.toThrow('boom');
    const saved = repo.save.mock.calls.at(-1)[0] as Video;
    // still PROCESSING because more retries remain
    expect(saved.status).toBe(VideoStatus.PROCESSING);
  });

  it('does nothing when the video row is missing', async () => {
    repo = makeRepo(null);
    processor = new VideoProcessingProcessor(
      repo as unknown as VideoProcessingProcessor['videoRepository'],
      storage as unknown as StorageService,
      ffmpeg as unknown as FfmpegService,
    );
    await processor.process(makeJob());
    expect(repo.save).not.toHaveBeenCalled();
  });
});
