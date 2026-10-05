import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockedGetSignedUrl = getSignedUrl as jest.MockedFunction<
  typeof getSignedUrl
>;

const cfg = storageConfig();

function lastCallPayload(): unknown {
  const args = mockedGetSignedUrl.mock.calls[0] ?? [];
  const command = args[1] as unknown;
  return (command as { input?: unknown }).input;
}

describe('StorageService (unit)', () => {
  let service: StorageService;

  beforeAll(() => {
    service = new StorageService(cfg);
  });

  beforeEach(() => {
    mockedGetSignedUrl.mockReset();
    mockedGetSignedUrl.mockResolvedValue('https://presigned.example');
  });

  it('presignGet issues a GetObjectCommand with the key and no disposition', async () => {
    const url = await service.presignGet('videos/abc/source.mp4');
    expect(url).toBe('https://presigned.example');
    expect(mockedGetSignedUrl).toHaveBeenCalledTimes(1);
    const input = lastCallPayload() as { Bucket: string; Key: string };
    expect(input.Bucket).toBe(cfg.bucket);
    expect(input.Key).toBe('videos/abc/source.mp4');
  });

  it('presignGet forwards a Content-Disposition when provided', async () => {
    await service.presignGet('videos/abc/source.mp4', {
      disposition: 'attachment; filename="clip.mp4"',
    });
    const input = lastCallPayload() as { ResponseContentDisposition?: string };
    expect(input.ResponseContentDisposition).toBe(
      'attachment; filename="clip.mp4"',
    );
  });

  it('presignPut issues a PutObjectCommand', async () => {
    await service.presignPut('videos/abc/cover.png');
    const command = mockedGetSignedUrl.mock.calls[0][1];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input.Key).toBe(
      'videos/abc/cover.png',
    );
  });

  it('presignCreateMultipart issues a CreateMultipartUploadCommand', async () => {
    const url = await service.presignCreateMultipart('videos/abc/source.mp4');
    expect(url).toBe('https://presigned.example');
    const command = mockedGetSignedUrl.mock.calls[0][1];
    expect(command).toBeInstanceOf(CreateMultipartUploadCommand);
  });

  it('presignUploadPart issues an UploadPartCommand with uploadId + partNumber', async () => {
    await service.presignUploadPart('videos/abc/source.mp4', 'upload-1', 2);
    const command = mockedGetSignedUrl.mock.calls[0][1] as UploadPartCommand;
    expect(command).toBeInstanceOf(UploadPartCommand);
    expect(command.input).toMatchObject({
      Key: 'videos/abc/source.mp4',
      UploadId: 'upload-1',
      PartNumber: 2,
    });
  });

  it('presignCompleteMultipart issues a CompleteMultipartUploadCommand with parts', async () => {
    await service.presignCompleteMultipart(
      'videos/abc/source.mp4',
      'upload-1',
      [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    );
    const command = mockedGetSignedUrl.mock
      .calls[0][1] as CompleteMultipartUploadCommand;
    expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(command.input).toMatchObject({
      Key: 'videos/abc/source.mp4',
      UploadId: 'upload-1',
      MultipartUpload: {
        Parts: [
          { ETag: '"etag-1"', PartNumber: 1 },
          { ETag: '"etag-2"', PartNumber: 2 },
        ],
      },
    });
  });

  it('presignAbortMultipart issues an AbortMultipartUploadCommand', async () => {
    await service.presignAbortMultipart('videos/abc/source.mp4', 'upload-1');
    const command = mockedGetSignedUrl.mock.calls[0][1];
    expect(command).toBeInstanceOf(AbortMultipartUploadCommand);
  });

  it('all presign methods pass the configured presigned ttl as expiresIn', async () => {
    mockedGetSignedUrl.mockClear();
    mockedGetSignedUrl.mockResolvedValue('x');
    await Promise.all([
      service.presignGet('k'),
      service.presignPut('k'),
      service.presignCreateMultipart('k'),
      service.presignUploadPart('k', 'u', 1),
      service.presignCompleteMultipart('k', 'u', []),
      service.presignAbortMultipart('k', 'u'),
    ]);
    for (const args of mockedGetSignedUrl.mock.calls) {
      expect(args[2]).toMatchObject({ expiresIn: cfg.presignedUrlTtlSeconds });
    }
  });

  it('ensureBucket tolerates a pre-existing bucket (409)', async () => {
    const send = jest.fn().mockRejectedValue({
      $metadata: { httpStatusCode: 409 },
      name: 'BucketAlreadyOwnedByYou',
    });
    (service as unknown as { getClient: () => unknown }).getClient = () => ({
      send,
    });
    await expect(service.ensureBucket()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ensureBucket rethrows non-409 errors', async () => {
    const send = jest.fn().mockRejectedValue({
      $metadata: { httpStatusCode: 500 },
    });
    (service as unknown as { getClient: () => unknown }).getClient = () => ({
      send,
    });
    await expect(service.ensureBucket()).rejects.toMatchObject({
      $metadata: { httpStatusCode: 500 },
    });
  });
});
