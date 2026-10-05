import * as crypto from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { VideoStatus } from '../src/videos/entities/video.entity';
import { VideoResponseDto } from '../src/videos/dto/video.dto';
import { cleanAllTables } from '../src/test/create-test-data-source';

const execFile = promisify(execFileCb);
const PART1 = 5 * 1024 * 1024; // first part must be >= 5 MB (S3 rule)

jest.setTimeout(90_000);

async function buildLargeMp4(): Promise<Buffer> {
  const dir = await fs.mkdtemp(`${os.tmpdir()}/e2e-`);
  const src = path.join(dir, 'src.mp4');
  await execFile('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=64x64:duration=1',
    '-pix_fmt',
    'yuv420p',
    '-y',
    src,
  ]);
  const mp4 = Buffer.from(await fs.readFile(src));
  await fs.rm(dir, { recursive: true, force: true });

  const freeDataLen = PART1 + 2048 - mp4.length; // pad past 5 MB
  const freeBox = Buffer.alloc(8 + freeDataLen);
  freeBox.writeUInt32BE(8 + freeDataLen, 0);
  freeBox.write('free', 4);
  freeBox.fill(0, 8);
  return Buffer.concat([mp4, freeBox]);
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function loginToken(): Promise<string> {
    const authService = app.get(AuthService);
    const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
    let captured = '';
    interface MailSpy {
      sendConfirmationEmail: (
        email: string,
        name: string,
        token: string,
      ) => Promise<void>;
    }
    const mailService = (authService as unknown as { mailService: MailSpy })
      .mailService;
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(
        (_email: string, _name: string, token: string) => {
          captured = token;
          return Promise.resolve();
        },
      );
    await authService.register({ email, password: 'password123' });
    await authService.confirm(captured);
    const tokens = await authService.login({ email, password: 'password123' });
    return tokens.access_token;
  }

  async function uploadVideo(token: string): Promise<string> {
    const object = await buildLargeMp4();
    const part1 = object.subarray(0, PART1);
    const part2 = object.subarray(PART1);

    const created = (
      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          filename: 'e2e.mp4',
          content_type: 'video/mp4',
          size_bytes: object.length,
        })
        .expect(201)
    ).body as { id: string };
    const id = created.id;

    const session = (
      await request(app.getHttpServer())
        .post(`/videos/${id}/uploads`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body as { upload_id: string };
    const { upload_id } = session;

    const parts: { part_number: number; etag: string }[] = [];
    for (const [partNumber, body] of [
      [1, part1],
      [2, part2],
    ] as const) {
      const p = (
        await request(app.getHttpServer())
          .post(`/videos/${id}/uploads/parts`)
          .set('Authorization', `Bearer ${token}`)
          .send({ upload_id, part_number: partNumber, part_size: body.length })
          .expect(200)
      ).body as { url: string };
      const put = await fetch(p.url, {
        method: 'PUT',
        body: new Uint8Array(body),
      });
      expect(put.ok).toBe(true);
      parts.push({
        part_number: partNumber,
        etag: put.headers.get('etag') ?? '',
      });
    }

    await request(app.getHttpServer())
      .post(`/videos/${id}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ upload_id, parts, size_bytes: object.length })
      .expect(200);
    return id;
  }

  async function awaitReady(
    token: string,
    id: string,
  ): Promise<VideoResponseDto> {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const body = res.body as VideoResponseDto;
      if (body.status === VideoStatus.READY) return body;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('video did not become ready in time');
  }

  it('guards unauthenticated access to video endpoints', async () => {
    await request(app.getHttpServer()).post('/videos').send({}).expect(401);
    await request(app.getHttpServer()).get('/videos/some-id').expect(401);
  });

  it('pre-registers a draft and exposes the upload session', async () => {
    const token = await loginToken();
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'draft.mp4', content_type: 'video/mp4' })
      .expect(201);
    const body = res.body as {
      id: string;
      status: string;
      unique_id: string;
      storage_key: string;
    };

    expect(body.status).toBe(VideoStatus.DRAFT);
    expect(body.unique_id).toMatch(/^[A-Za-z0-9]{1,12}$/);
    expect(body.storage_key).toMatch(/^videos\/[A-Za-z0-9]+\/source\.mp4$/);
    await request(app.getHttpServer())
      .post(`/videos/${body.id}/uploads`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('runs the full pipeline: draft → upload → process → stream/download', async () => {
    const token = await loginToken();
    const id = await uploadVideo(token);

    const video = await awaitReady(token, id);
    expect(video.status).toBe(VideoStatus.READY);
    expect(video.duration_seconds).toBeGreaterThan(0);
    expect(video.width).toBeGreaterThan(0);
    expect(video.thumbnail_url).toContain('thumbnail.jpg');
    expect(Number(video.size_bytes)).toBeGreaterThan(PART1);

    // Streaming (anonymous) with Range
    const playRes = await request(app.getHttpServer())
      .get(`/videos/${id}/play-url`)
      .expect(200);
    const play = playRes.body as { url: string; expires_at: string };
    const range = await fetch(play.url, {
      headers: { Range: 'bytes=0-255' },
    });
    expect(range.status).toBe(206);

    // Download (authenticated) with Content-Disposition
    const dlRes = await request(app.getHttpServer())
      .get(`/videos/${id}/download-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const dl = dlRes.body as { url: string; filename: string };
    const dlResp = await fetch(dl.url);
    expect(dlResp.status).toBe(200);
    expect(dlResp.headers.get('content-disposition')).toContain('attachment');
  });

  it('returns 409 for play-url while the video is not ready', async () => {
    const token = await loginToken();
    const draftRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'x.mp4', content_type: 'video/mp4' })
      .expect(201);
    const draft = draftRes.body as { id: string };
    const res = await request(app.getHttpServer())
      .get(`/videos/${draft.id}/play-url`)
      .expect(409);
    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
  });
});
