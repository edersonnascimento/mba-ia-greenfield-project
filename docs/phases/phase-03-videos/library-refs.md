# phase-03-videos — Library References

State: resolved per `docs/decisions/technical-decisions-phase-03-videos.md` (decided) — validated via context7 on 2026-09-07.
Scope: `nestjs-project/` only.

## New runtime dependencies (to install in `nestjs-project`)

| Library | Version (major pin) | Purpose | Context7 verified API |
|---------|--------------------|---------|----------------------|
| `@nestjs/bullmq` | `^11.0.0` (CJS) | NestJS ↔ BullMQ integration: `BullModule.forRootAsync`/`BullModule.registerQueue`, `@InjectQueue('video') Queue`, `@Processor('video')` + `extends WorkerHost`/`process(job)`, `QueueEventsHost` + `@QueueEventsListener` + `@OnQueueEvent` | Yes — `BullModule.forRoot({ connection })`, named queues, processor providers |
| `bullmq` | `^5.0.0` | BullMQ runtime (Redis queue); `Queue`, `Job`, `Worker`; job options `attempts`/`backoff` | Yes — `Queue.add`, job retries |
| `ioredis` | `^5.0.0` | Redis client consumed by BullMQ connection | — (transitive; explicit for cli/test tools if needed) |
| `@aws-sdk/client-s3` | `^3.x` | S3/MInIO client: `S3Client`, commands `GetObjectCommand`, `PutObjectCommand`, `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`, `HeadObjectCommand`; config `region`, `credentials`, `endpoint`, `forcePathStyle: true` (MinIO) | Yes — v3 client + command classes; `getSignedUrl(client, command, { expiresIn })` |
| `@aws-sdk/s3-request-presigner` | `^3.x` | `getSignedUrl()` generating presigned GET/upload-part URLs for the API | Yes — presign `GetObjectCommand`, `UploadPartCommand` |

## System / non-npm provisioning

| Component | Version | Purpose | Where |
|-----------|---------|---------|-------|
| `ffmpeg` / `ffprobe` | distro `ffmpeg` (>= 5.x, Debian stable) | Metadata extraction (`ffprobe -print_format json`) and thumbnail frame capture (`ffmpeg -ss ... -frames:v 1`) | Installed in the `video-worker` Docker image via apt (Dockerfile) |
| MinIO | `minio/minio` (latest stable, RELEASE.2025+) | S3-compatible object storage for dev; API-compatible with AWS S3 | `nestjs-project/compose.yaml` service `minio` |
| Redis | `redis:7-alpine` | BullMQ backing store | `nestjs-project/compose.yaml` service `redis` |

## Configuration surface

New env vars to declare in `.env.example` + Joi schema (`src/config/env.validation.ts`), sourced from new config namespaces:

- `storage.config.ts` (`registerAs('storage', ...)`): `S3_ENDPOINT` (default `http://minio:9000`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY` (default `minioadmin`), `S3_SECRET_KEY` (default `minioadmin`), `S3_BUCKET` (default `streamtube`), `S3_PRESIGNED_URL_TTL_SECONDS` (default `3600`)
- `queue.config.ts` (`registerAs('queue', ...)`): `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`), `QUEUE_VIDEO_PROCESSING` (default `video-processing`), `QUEUE_ATTEMPTS` (default `3`)

## Retry / job policy (fixed values, per TD-07)

- `video-processing` queue job options: `attempts: 3`, `backoff: { type: 'exponential', multiplier: 2000 }` (2s, 4s).
- Presigned upload session URLs: `expiresIn: 3600` seconds (config `S3_PRESIGNED_URL_TTL_SECONDS`).
- Thumbnail: `videos/{videoId}/thumbnail.jpg`; source: `videos/{videoId}/source.{ext}` (TD-03).