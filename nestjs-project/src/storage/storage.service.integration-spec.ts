import * as crypto from 'crypto';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration, MinIO)', () => {
  let svc: StorageService;
  const cfg = storageConfig();

  beforeAll(async () => {
    svc = new StorageService(cfg);
    await svc.ensureBucket();
  });

  it('creates the bucket idempotently', async () => {
    await svc.ensureBucket();
    await svc.ensureBucket();
  });

  it('round-trips a small object via putObject + presignGet', async () => {
    const key = `test/${crypto.randomUUID()}.bin`;
    const body = Buffer.from('streaming round-trip', 'utf-8');
    await svc.putObject(key, body, 'application/octet-stream');

    const head = await svc.headObject(key);
    expect(head.size).toBe(body.length);

    const url = await svc.presignGet(key);
    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    const received = Buffer.from(await resp.arrayBuffer());
    expect(received.toString()).toBe('streaming round-trip');
  });

  it('supports HTTP Range (206 Partial Content) on a presigned URL', async () => {
    const key = `test/${crypto.randomUUID()}.bin`;
    await svc.putObject(key, Buffer.from('0123456789', 'utf-8'));

    const url = await svc.presignGet(key);
    const resp = await fetch(url, { headers: { Range: 'bytes=0-3' } });
    expect(resp.status).toBe(206);
    const received = Buffer.from(await resp.arrayBuffer());
    expect(received.toString()).toBe('0123');
  });

  it('serves Content-Disposition attachment for downloads', async () => {
    const key = `test/${crypto.randomUUID()}.mp4`;
    await svc.putObject(key, Buffer.from('file', 'utf-8'));
    const url = await svc.presignGet(key, {
      disposition: 'attachment; filename="clip.mp4"',
    });
    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-disposition')).toContain('attachment');
  });

  it('completes a 2-part multipart upload and verifies the object size', async () => {
    const key = `test/${crypto.randomUUID()}.bin`;
    const uploadId = await svc.createMultipart(key);

    const partA = Buffer.alloc(5 * 1024 * 1024); // S3: every part except the last must be >= 5 MB
    partA.fill(65); // 'A'
    const resA = await fetch(await svc.presignUploadPart(key, uploadId, 1), {
      method: 'PUT',
      body: partA,
    });
    expect(resA.ok).toBe(true);
    const etagA = resA.headers.get('etag') ?? '';

    const partB = Buffer.from('tail-part', 'utf-8');
    const resB = await fetch(await svc.presignUploadPart(key, uploadId, 2), {
      method: 'PUT',
      body: partB,
    });
    expect(resB.ok).toBe(true);
    const etagB = resB.headers.get('etag') ?? '';

    await svc.completeMultipart(key, uploadId, [
      { partNumber: 1, etag: etagA },
      { partNumber: 2, etag: etagB },
    ]);

    const head = await svc.headObject(key);
    expect(head.size).toBe(partA.length + partB.length);
  });
});
