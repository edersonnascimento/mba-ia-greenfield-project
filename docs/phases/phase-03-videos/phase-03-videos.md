---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-07T13:13:12-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-07T13:33:24-03:00"
  docs/phases/phase-03-videos/context.md: "2026-09-07T13:35:41-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-07T13:40:00-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the full backend video capability: upload files up to 10GB without blocking the API (presigned S3 multipart, direct-to-MinIO), automatic pre-registration as a draft, asynchronous processing (ffprobe metadata extraction + ffmpeg thumbnail) via a BullMQ worker, a unique short URL per video, and streaming + download through presigned URLs — all running with object storage (MinIO), queue (Redis) and worker as new Docker Compose services.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose Infrastructure

**Description:** Install Phase 03 production dependencies, create `storage` and `queue` config namespaces following the `registerAs` pattern, extend the Joi env-validation schema, and add MinIO, Redis and the video worker to `compose.yaml`.

**Technical actions:**

- Install in nestjs-project: `@nestjs/bullmq@^11.x` (CJS — v12 is ESM and incompatible with the ts-jest test stack), `bullmq@^5.x`, `ioredis@^5.x`, `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `S3_ENDPOINT` (default `http://minio:9000`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY` (default `minioadmin`), `S3_SECRET_KEY` (default `minioadmin`), `S3_BUCKET` (default `streamtube`), `S3_PRESIGNED_URL_TTL_SECONDS` (number, default `3600`), `S3_PART_SIZE` (number, default `52428800` = 50MB)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`), `QUEUE_VIDEO_PROCESSING` (default `video-processing`), `QUEUE_ATTEMPTS` (default `3`)
- Update `src/config/env.validation.ts` — add all new variables to the Joi schema (S3 keys with defaults; REDIS_HOST default `redis`). Update `.env.example` with Docker Compose-compatible defaults
- Register `storageConfig` and `queueConfig` in `AppModule` `ConfigModule.forRoot({ load: [...] })`
- Add Compose services in `nestjs-project/compose.yaml`:
  - `minio` — image `minio/minio`, command `server /data --console-address :9001`, ports `9000`/`9001`, env `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, volume `minio_data`, healthcheck `mc ready local` via `mc` (or `curl -f http://localhost:9000/minio/health/live`), `nestjs-api` depends on it `condition: service_healthy`
  - `redis` — image `redis:7-alpine`, port `6379`, healthcheck `redis-cli ping`, `nestjs-api` and `video-worker` depend on it `service_healthy`
  - `video-worker` — build from `Dockerfile.dev` plus `ffmpeg`/`ffprobe` installed (extend via a `Dockerfile.worker` that `FROM` the dev image and `RUN apt-get install -y ffmpeg`), command `npm run start:worker`, depends on `redis`, `db`, `minio`
- Add `start:worker` script in `package.json` (`nest start src/worker/main.worker.ts`)

**Dependencies:** None

**Acceptance criteria:**

- Application boots with the new env vars present; existing E2E `GET /` still returns 200
- `minio`, `redis`, `video-worker` services reach `running`/`healthy` via `docker compose ps`
- `minio` is reachable; a bucket (see SI-03.2 bootstrap) is created
- `npm run migration:run` works (schema unchanged in this SI)

---

### SI-03.2 — Object Storage Client Module (S3/MinIO)

**Description:** Create a `StorageModule` owning the S3/MinIO client, an `ensureBucket` bootstrap, presigned URL generation (presigned get/put/upload-part/create-multipart/complete/abort), and object I/O helpers the worker uses.

**Technical actions:**

- Create `src/storage/storage.config` wiring — build one `S3Client` from `storageConfig`: `region`, `credentials: { accessKeyId, secretAccessKey }`, `endpoint: s3.endpoint`, `forcePathStyle: true` (required for MinIO)
- Create `src/storage/storage.module.ts` — `StorageModule` with `forRoot()` route providing `StorageService`
- Create `src/storage/storage.service.ts` — `StorageService`:
  - `ensureBucket(): Promise<void>` — `CreateBucketCommand` (tolerate `BucketAlreadyOwnedByYou`/409)
  - `headObject(key): Promise<{ size, etag }>` — `HeadObjectCommand`
  - `presignGet(key, { expiresIn, disposition? }): Promise<string>` — `getSignedUrl(client, new GetObjectCommand({...}), { expiresIn })`; with `disposition` sets `ResponseContentDisposition: 'attachment; filename=...'`
  - `presignPut(key): Promise<string>` — `PutObjectCommand`
  - `presignCreateMultipart(key): Promise<string>` — `CreateMultipartUploadCommand`
  - `presignUploadPart(key, { uploadId, partNumber, partSize }): Promise<string>` — `UploadPartCommand`
  - `presignCompleteMultipart(key, { uploadId, parts }): Promise<string>` — `CompleteMultipartUploadCommand`
  - `presignAbortMultipart(key, { uploadId }): Promise<string>` — `AbortMultipartUploadCommand`
  - `createMultipart(key): Promise<string /*uploadId*/>`, `completeMultipart(key, { uploadId, parts })`, `abortMultipart(key, { uploadId })` — direct server-side command calls
  - `readStream(key)` / `writeBuffer(key, buffer)` — worker helpers via `GetObjectCommand`/`PutObjectCommand` with `@aws-sdk/lib-storage` `Upload`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.spec.ts` | Unit | presign methods call `getSignedUrl` with the right command/options; ensureBucket tolerates existing bucket |
| `src/storage/storage.service.integration-spec.ts` | Integration | against real `minio`: `ensureBucket` creates `streamtube`; `presignGet`+`presignPut` round-trip a small buffer; `createMultipart`/`presignUploadPart`/`completeMultipart` round-trip a 2-part object; `headObject` returns expected size/etag |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `ensureBucket` creates the `streamtube` bucket (idempotent)
- A small file presigned-`PUT` then presigned-`GET` round-trips to MinIO without the API forwarding bytes
- A 2-part multipart upload completes into a single object whose `headObject` size/etag match
- All presign methods use the S3 v3 command API and MinIO-compatible `forcePathStyle`

---

### SI-03.3 — Video Entity and Migration

**Description:** Create the `Video` entity (`videos` table) per TD-08, generate the migration, and register the entity for TypeORM discovery.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns: `id` (uuid PK generated `uuid4`), `channel_id` (uuid FK → channels.id), `title` (varchar(255)), `unique_id` (varchar(32), unique `@Index({ unique: true })`), `status` (`@Column({ type: 'enum', enum: ['draft','processing','ready','failed'] })`), `storage_key` (varchar, nullable), `content_type` (varchar, nullable), `size_bytes` (bigint, nullable), `duration_seconds` (int, nullable), `width` (int, nullable), `height` (int, nullable), `codec` (varchar, nullable), `thumbnail_key` (varchar, nullable), `processing_error` (text, nullable), `created_at` (`@CreateDateColumn`), `updated_at` (`@UpdateDateColumn`). Define `@ManyToOne(() => Channel, { onDelete: 'CASCADE' })` + `@JoinColumn({ name: 'channel_id' })`. Add `@Index` on `(channel_id)`
- Create `src/videos/unique-id.util.ts` — `generateUniqueId(): string` — `crypto.randomBytes(8)` → base-62 encode → ~12 chars
- Generate migration `npm run migration:generate -- src/database/migrations/CreateVideos` (Status enum type `video_status`; unique index `uidx_videos_unique_id`; FK `videos_channel_id_fkey`; index `videos_channel_id_idx`) and review
- Ensure `videos/` module registered; `autoLoadEntities: true` already picks up the entity

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/unique-id.util.spec.ts` | Unit | base-62 output is URL-safe `[A-Za-z0-9]`, ~12 chars, two calls differ |
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | persists; `unique_id` unique constraint; `status` enum rejects invalid; `channel_id` FK cascade; timestamps auto-filled |
| `src/database/migrations.integration-spec.ts` | Integration | extends the existing migration-runner test to assert the `videos` table exists after `runMigrations()` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates `videos` with `video_status` enum, unique index on `unique_id`, FK on `channel_id`
- Inserting a duplicate `unique_id` fails; an invalid `status` value fails
- A `Video` links to a `Channel`; deleting the channel deletes the videos (CASCADE)

---

### SI-03.4 — Queue Module (BullMQ) and Producer

**Description:** Configure BullMQ (`@nestjs/bullmq`) in a `QueueModule`, register the `video-processing` queue, and expose `VideosQueue` to enqueue processing jobs with the retry policy of TD-07.

**Technical actions:**

- Create `src/queue/queue.module.ts` — `QueueModule` with imports `BullModule.forRoot({ connection: { host: queueConfig.redisHost, port: queueConfig.redisPort } })` and `BullModule.registerQueue({ name: queueConfig.videoProcessingQueue })`
- Create `src/queue/videos.queue.ts` — `VideosQueue` service injecting `@InjectQueue(QUEUE_NAME) private queue: Queue`. Implement `enqueueProcessing({ videoId, storageKey }): Promise<string /*jobId*/>` calling `queue.add('video-processing', { videoId, storageKey }, { attempts: queueConfig.attempts, backoff: { type: 'exponential', multiplier: 2000 }, jobId: `video-${videoId}` })`. The `jobId` makes enqueue idempotent (re-enqueue returns the existing job)
- Export `VideosQueue` from `QueueModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/videos.queue.spec.ts` | Unit | `enqueueProcessing` calls `queue.add` with the payload + retry job options |
| `src/queue/videos.queue.integration-spec.ts` | Integration | against real `redis`: `enqueueProcessing` lands a job on the `video-processing` queue; a duplicate `jobId` does not duplicate the job |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- A job published by `enqueueProcessing` is visible on the `video-processing` queue (via a plain `bullmq` `Worker`/`Queue`)
- Job options carry `attempts: 3` and exponential backoff
- Re-enqueuing the same `videoId` does not create a second job

---

### SI-03.5 — Videos Service and Controller: Draft Pre-Registration + Upload Session

**Description:** Implement the `videos` feature module: `VideosService` + `VideosController` for creating a draft on upload start (TD-02) and issuing presigned multipart session URLs.

**Technical actions:**

- Create `src/videos/videos.service.ts` — `VideosService` injecting `@InjectRepository(Video)`, `ChannelsService` repository access (or `TypeOrmModule.forFeature([Channel])`), `StorageService`, `VideosQueue`:
  - `createDraft(channelId, { filename, content_type, size_bytes }): Promise<Video>` — `crypto.randomBytes(8)`-seeded `unique_id`; `storage_key = \`videos/${unique_id}/source.${extFrom(filename)}\``; `status='draft'`; save; return
  - `initiateUpload(videoId, channelId): Promise<{ upload_id, key, part_size }>` — guard owner; require `status='draft'`; `storageService.createMultipart(storageKey)` → persist nothing (re-init is fine); return `{ upload_id, key, part_size: s3.partSize }`
  - `issuePartUrl(videoId, channelId, { upload_id, part_number, part_size }): Promise<{ part_number, url }>` — `storageService.presignUploadPart(...)`
  - `getVideo(videoId, channelId)` / ownership helpers
- Create `src/videos/dto/create-video.dto.ts` — `CreateVideoDto` with `@IsString() @IsNotEmpty()` filename, `@IsString()` content_type, `@IsNumber() @IsOptional()` size_bytes
- Create `src/videos/dto/part-url.dto.ts` — `PartUrlDto` with `@IsString()` upload_id, `@IsInt() @Min(1)` part_number, `@IsInt() @Min(1)` part_size
- Create `src/videos/videos.controller.ts` — `VideosController` prefix `'videos'`, JWT-guarded:
  - `POST /videos` → 201 draft
  - `POST /videos/:id/uploads` → initiate (server-side CreateMultipartUpload)
  - `POST /videos/:id/uploads/parts` → presigned part URL
- Create `src/videos/videos.module.ts` — `VideosModule` importing `TypeOrmModule.forFeature([Video, Channel])`, `StorageModule`, `QueueModule`, `ChannelsModule`; provide `VideosService`
- Extract `channelId` from the authenticated user (the user's channel) via a `channel-from-user` helper in `ChannelsService`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `createDraft` builds storage_key + unique_id + status draft; `initiateUpload` reuses storage; ownership/status guards throw |
| `src/videos/videos.service.integration-spec.ts` | Integration | `createDraft` persists a draft linked to the channel; `initiateUpload` returns a valid upload_id against real MinIO |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos` 201 draft (auth required, owner-only); 401 unauthenticated; `POST /videos/:id/uploads` returns upload_id; 404 unknown; 403 not-owner |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos` creates a `draft` video, storage key `videos/{unique_id}/source.{ext}`, and a short unique URL id
- `POST /videos/:id/uploads` returns a valid multipart `upload_id`
- Only the channel owner can issue parts; non-draft videos are rejected for upload

---

### SI-03.6 — Upload Completion (Complete Multipart + Verify + Enqueue)

**Description:** Implement the upload completion handler: complete the multipart upload server-side, verify the object with HEAD, transition status to `processing`, and enqueue the processing job.

**Technical actions:**

- Implement in `VideosService`:
  - `abort(videoId, channelId, { upload_id }): Promise<void>` — `storageService.abortMultipart(...)`; make the draft re-uploadable
  - `complete(videoId, channelId, { upload_id, parts, size_bytes }): Promise<Video>` — guard owner + `status='draft'`; `storageService.completeMultipart(storageKey, { upload_id, parts })`; `head = storageService.headObject(storageKey)`; if `size_bytes` provided and mismatch → throw `VideoObjectVerificationFailedException`; save `status='processing'`, `size_bytes=head.size`, `content_type`; call `videosQueue.enqueueProcessing({ videoId, storageKey })`; return video
- Add `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` with `@IsString()` upload_id, `@IsArray()` parts (`@ValidateNested({ each: true })` `@Type(() => PartDto)` where `PartDto` has `@IsInt() @Min(1)` part_number and `@IsString()` etag), `@IsOptional() @IsNumber()` size_bytes
- Add endpoints to `VideosController`: `POST /videos/:id/uploads/complete` → 200 `{ id, status }`; `POST /videos/:id/uploads/abort` → 204

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | complete validates status/owner; HEAD mismatch throws; enqueues processing job on success |
| `src/videos/videos.service.integration-spec.ts` | Integration | full multipart round trip against MinIO then `complete` → object exists, HEAD size matches, status = processing, job enqueued (real Redis) |
| `test/videos.e2e-spec.ts` | E2E | upload 2 small parts → `POST /videos/:id/uploads/complete` 200 with status processing; abort resets draft; 409/403/404 errors |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- After completion the object is fully assembled in MinIO, status = `processing`, size recorded
- The processing job is published to `video-processing` with the correct payload
- Completing a non-draft or non-owned video is rejected

---

### SI-03.7 — Video Processing Worker (ffprobe metadata + ffmpeg thumbnail)

**Description:** Implement the nested worker: a `@Processor('video-processing')` that downloads the source, extracts duration/metadata with `ffprobe`, generates a thumbnail with `ffmpeg`, uploads it, and flips the row to `ready` (or `failed` after retries).

**Technical actions:**

- Create `src/worker/video-processing.processor.ts` — `@Processor(QUEUE_NAME)` class extending `WorkerHost` (registered as a provider) with `async process(job: Job<{ videoId, storageKey }>)`:
  - Load the `Video` row; set `status='processing'`; read the source from MinIO to a temp file; probe with `ffprobe -v quiet -print_format json -show_format -show_streams` via `child_process.execFile`/`spawn` → parse `duration`, `width`, `height`, `codec`
  - Generate thumbnail with `ffmpeg -ss 1 -i <tmp> -frames:v 1 -vf scale=320:-1 <tmpthumb.jpg>` (fallback `-ss 0` if <1s)
  - Upload thumbnail to `videos/{unique_id}/thumbnail.jpg` via `storageService.writeBuffer(thumbnailKey, thumbBuffer)`; save `duration_seconds`, `width`, `height`, `codec`, `thumbnail_key`, `status='ready'`
  - On unrecoverable error rethrow (BullMQ retries `attempts:3`); on final failure set `status='failed'`,`processing_error`
- Create `src/worker/worker.module.ts` — `WorkerModule` importing `TypeOrmModule.forFeature([Video, Channel])`, `StorageModule`; provide `VideoProcessingProcessor`
- Create `src/worker/main.worker.ts` — Nest bootstrap loading `WorkerModule` (+ `ConfigModule`/`TypeOrmModule` equivalents to `AppModule`) and `app.listen(...)`; used by `npm run start:worker`. Guard the worker's own HTTP port on `0.0.0.0:3001` (or a separate port) so it does not clash with the API
- Wire a `QueueEventsListener` (`@QueueEventsListener(QUEUE_NAME)`) to log `failed` with the videoId for observability

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/video-processing.processor.spec.ts` | Unit | mocks child-process/ffprobe output, storage, repo — metadata parses, thumbnail uploaded, status → ready; on probe failure → throws (retry) |
| `src/worker/video-processing.processor.integration-spec.ts` | Integration | against real MinIO + Redis + DB: enqueue a tiny real video fixture (a small generated mp4), run the processor, assert the Video row → ready with duration>0 and thumbnail object exists in MinIO |

**Dependencies:** SI-03.6, SI-03.2

**Acceptance criteria:**

- A `video-processing` job ends with the video row `status='ready'`, `duration_seconds`, `width`, `height`, `codec`, `thumbnail_key` populated
- `videos/{unique_id}/thumbnail.jpg` exists in MinIO after processing
- A job whose probe fails is retried up to 3 times, then the row is `failed` with `processing_error`

---

### SI-03.8 — Streaming, Download, and Video Detail Endpoints

**Description:** Expose play/download presigned URLs (TD-06) and the video detail resource, gated by status and ownership.

**Technical actions:**

- Implement in `VideosService`:
  - `getPlayUrl(videoId): Promise<{ url, expires_at }>` — require `status='ready'`; `presignGet(storageKey, { expiresIn: s3.presignedUrlTtlSeconds })`; return URL + expiry
  - `getDownloadUrl(videoId, channelId, isOwner): Promise<{ url, filename }>` — require ready; `presignGet(storageKey, { disposition: \`attachment; filename="${title}".mp4\` })`
  - `getVideo(videoId, channelId): Promise<Video>` — JOIN channel; 404 if not found or not owner
- Add `src/videos/dto/` response DTOs and endpoints:
  - `GET /videos/:id/play-url` (**public** — `@Public()`; anonymous watch per TD-06)
  - `GET /videos/:id/download-url` (auth; any authenticated user)
  - `GET /videos/:id` (auth; owner only) — returns `{ id, unique_id, title, status, size_bytes, duration_seconds, width, height, codec, thumbnail_url, video_url, created_at }`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | play-url requires ready; download-url builds attachment disposition; ownership guard |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:id` owner-only; `GET /videos/:id/play-url` works anonymously for a ready video and 409 for a draft; `GET /videos/:id/download-url` requires auth; a presigned play URL issued then fetched with a `Range: bytes=0-99` returns 206 |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Streaming: a presigned play URL fetched with `Range` returns `206 Partial Content` (MinIO) for a `ready` video; anonymous access works
- Download: a presigned download URL triggers `Content-Disposition: attachment`
- Detail endpoint returns the metadata written by the worker; non-ready videos get correct status-based errors

---

### SI-03.9 — Closing: Full Suite, TypeScript, Lint, Documentation

**Description:** Run the full verification gate, create/update `progress.md`, update the architecture diagram (queue `TBD` → `BullMQ (Redis)`) and `CLAUDE.md` sections for videos/module/storage/worker.

**Technical actions:**

- Run `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit` (code 0), `npm run lint` — fix any failures
- Verify `docker compose ps` shows `minio`, `redis`, `video-worker` healthy together with `nestjs-api`, `db`, `mailpit`
- Update `docs/phases/phase-03-videos/progress.md` with per-SI status + test counts
- Update `docs/diagrams/software-arch.mermaid` — set the Message Queue container label to `BullMQ (Redis)`
- Update root `CLAUDE.md` (and `nestjs-project/CLAUDE.md`) with the videos module, endpoints, queue/worker and storage documentation, matching the implemented code

**Dependencies:** All prior SIs

**Acceptance criteria:**

- Definition of Done: full test suite green, `npx tsc --noEmit` exit 0, `npm run lint` passes
- All infra services healthy in compose
- `CLAUDE.md` sections accurate to the implemented code (no references to non-existent files/behaviors)

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | `uuid4` |
| channel_id | uuid | FK → channels.id, not null | Many-to-one to Channel; `ON DELETE CASCADE` |
| title | varchar(255) | not null | Stored title (originally the filename, editable in Fase 04) |
| unique_id | varchar(32) | unique, not null | base-62 short id (TD-05); used in URLs + storage keys |
| status | enum `video_status` | not null, default `draft` | `draft \| processing \| ready \| failed` (TD-07) |
| storage_key | varchar | nullable | MinIO key `videos/{unique_id}/source.{ext}` (TD-03) |
| content_type | varchar | nullable | e.g. `video/mp4` |
| size_bytes | bigint | nullable | from multipart completion / HEAD |
| duration_seconds | int | nullable | ffprobe, worker |
| width / height | int | nullable | ffprobe, worker |
| codec | varchar | nullable | ffprobe, worker |
| thumbnail_key | varchar | nullable | MinIO key `videos/{unique_id}/thumbnail.jpg` |
| processing_error | text | nullable | set on final failure |
| created_at / updated_at | timestamp | not null, auto | `@CreateDateColumn` / `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`)
**Indexes:** `(unique_id)` — unique; `(channel_id)` — FK lookup

---

### API Contracts

#### POST /videos (SI-03.5) — auth

**Request body:**
- filename: string, required
- content_type: string, required
- size_bytes: number, optional (client-declared expected size)

**Response 201:** `{ id, unique_id, title, status: 'draft', storage_key }`

**Errors:** 401 (no token), 403 (no channel), 400 (validation)

---

#### POST /videos/:id/uploads (SI-03.5) — auth (owner)

**Response 200:** `{ upload_id, key, part_size }`

**Errors:** 404 VIDEO_NOT_FOUND, 403 VIDEO_FORBIDDEN, 409 VIDEO_INVALID_STATUS (not draft)

---

#### POST /videos/:id/uploads/parts (SI-03.5) — auth (owner)

**Request body:** `{ upload_id, part_number, part_size }` (part_number ≥ 1)

**Response 200:** `{ part_number, url }` — client PUTs the part bytes **directly to MinIO** via `url`

**Errors:** 404/403/409 as above; 400 validation

---

#### POST /videos/:id/uploads/complete (SI-03.6) — auth (owner)

**Request body:** `{ upload_id, parts: [{ part_number, etag }], size_bytes? }`

**Response 200:** `{ id, status: 'processing' }`

**Errors:** 404 VIDEO_NOT_FOUND, 403 VIDEO_FORBIDDEN, 409 VIDEO_INVALID_STATUS, 409 VIDEO_OBJECT_VERIFICATION_FAILED (HEAD mismatch)

---

#### POST /videos/:id/uploads/abort (SI-03.6) — auth (owner)

**Response 204:** No content. Multipart aborted; draft re-uploadable.

---

#### GET /videos/:id (SI-03.8) — auth (owner)

**Response 200:** `{ id, unique_id, title, status, size_bytes, duration_seconds, width, height, codec, thumbnail_url, video_url, created_at }`

**Errors:** 404 VIDEO_NOT_FOUND, 403 VIDEO_FORBIDDEN

---

#### GET /videos/:id/play-url (SI-03.8) — public (`@Public()`)

**Response 200:** `{ url, expires_at }` — presigned GET; streams via Range/206 (MinIO)

**Errors:** 404 VIDEO_NOT_FOUND, 409 VIDEO_NOT_READY (unless status=`ready`)

---

#### GET /videos/:id/download-url (SI-03.8) — auth (any authenticated user)

**Response 200:** `{ url, filename }` — presigned GET with `Content-Disposition: attachment`

**Errors:** 401, 404, 409 VIDEO_NOT_READY

---

### Authorization Matrix

| Resource / action | Anonymous | Authenticated (non-owner) | Owner |
|--------------------|-----------|---------------------------|-------|
| POST /videos | — | ✓ | ✓ |
| POST /videos/:id/uploads | — | — | ✓ |
| POST /videos/:id/uploads/parts | — | — | ✓ |
| POST /videos/:id/uploads/complete | — | — | ✓ |
| POST /videos/:id/uploads/abort | — | — | ✓ |
| GET /videos/:id | — | — | ✓ |
| GET /videos/:id/play-url | ✓ | ✓ | ✓ |
| GET /videos/:id/download-url | — | ✓ | ✓ |

Ownership = the video's `channel_id` matches the authenticated user's channel.

---

### Error Catalog

| error code | HTTP | Message |
|------------|------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found |
| VIDEO_FORBIDDEN | 403 | You do not own this video |
| VIDEO_INVALID_STATUS | 409 | Video is in an invalid status for this operation |
| VIDEO_NOT_READY | 409 | Video is not ready |
| VIDEO_OBJECT_VERIFICATION_FAILED | 409 | Uploaded object does not match the expected size |

Implemented as `DomainException` subclasses in `src/videos/exceptions/`, mapped by the existing global `DomainExceptionFilter`.

---

### Events / Messages

**Queue:** `video-processing` (BullMQ, Redis consumer group)

| Field | Type | Notes |
|-------|------|-------|
| videoId | uuid | Video being processed |
| storageKey | string | MinIO source key |
| uploadId | string (nullable) | multipart upload id (present when processing from an in-flight session) |

**Job options:** `attempts: 3`, `backoff: { type: 'exponential', multiplier: 2000 }`, `jobId: 'video-{videoId}'` (idempotent).

**State transitions (actor: API `complete` / worker):**

| Event | From → To | Actor |
|-------|-----------|-------|
| draft created | — → draft | POST /videos |
| completed | draft → processing | POST /videos/:id/uploads/complete (enqueues job) |
| processing success | processing → ready | worker |
| processing failure (retries exhausted) | processing → failed | worker |
| aborted | processing? → draft (restart) | POST /videos/:id/uploads/abort |

**Observability:** a `QueueEventsListener` logs `completed` / `failed` (with videoId) for the `video-processing` queue.

---

## Dependency Map

```
SI-03.1 (deps, config, compose: minio/redis/worker)
   └──> SI-03.2 (storage client / presign)        [needs minio up]
   └──> SI-03.3 (video entity + migration)         [needs db up]
   └──> SI-03.4 (bullmq queue / producer)          [needs redis up]
SI-03.2 + SI-03.3 + SI-03.4 ──> SI-03.5 (draft + upload session endpoints)
SI-03.5 ──> SI-03.6 (completion + enqueue)
SI-03.6 + SI-03.2 ──> SI-03.7 (worker processor)
SI-03.6 ──> SI-03.8 (play/download/detail endpoints)
all ──> SI-03.9 (closing: suites, tsc, lint, docs, progress.md)
```

---

## Deliverables

- `docs/decisions/technical-decisions-phase-03-videos.md` (decided)
- `docs/phases/phase-03-videos/context.md`, `validation.md` (clean), `library-refs.md`, `phase-03-videos.md` (this plan), `progress.md`
- `nestjs-project/`:
  - `src/config/storage.config.ts`, `src/config/queue.config.ts` (+ `env.validation.ts` / `.env.example` updates)
  - `src/storage/` (module + `StorageService` + presign/[upload helpers])
  - `src/queue/` (`QueueModule`, `VideosQueue`, `QueueEventsListener`)
  - `src/videos/` (`Video` entity, `VideosService`, `VideosController`, DTOs, exceptions, `unique-id.util`)
  - `src/worker/` (`VideoProcessingProcessor`, `WorkerModule`, `main.worker.ts`)
  - `src/database/migrations/<timestamp>-CreateVideos.ts`
  - `compose.yaml` — `minio`, `redis`, `video-worker` + healthchecks
  - `Dockerfile.worker` (ffmpeg) + `start:worker` script
  - tests: `*.spec.ts`, `*.integration-spec.ts`, `test/videos.e2e-spec.ts`
- `docs/diagrams/software-arch.mermaid` — queue label → `BullMQ (Redis)`
- root `CLAUDE.md` + `nestjs-project/CLAUDE.md` updated with the videos section