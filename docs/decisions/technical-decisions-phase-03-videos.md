---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-07
scope_description: "Phase 03 backend foundation for video upload and processing: object storage blueprint (bucket/key layout, MinIO), message queue technology, upload strategy for files up to 10GB, FFmpeg-based worker (metadata + thumbnail), unique video URL, streaming/download via presigned URLs, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend delivering the whole phase: `videos/` module (draft pre-registration, presigned upload session, completion handler, status transitions), object storage client (MinIO via AWS SDK v3), message queue (BullMQ + Redis), a separate FFmpeg worker process, and new infrastructure (MinIO, Redis, worker) in `nestjs-project/compose.yaml`. No open decision for another subproject in this document.
- `next-frontend/` — Frontend deferred: the video upload/playback UI is not part of this phase (the interface de vídeo não faz parte do escopo desta fase). No open decision in this document.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The phase requires a background job queue so video processing (ffprobe/ffmpeg) runs out-of-band of the API. The project plan explicitly leaves the queue technology as "TBD" — this is the main open stack decision of the phase. The worker must support retries, backoff, job concurrency, and visibility into failed jobs.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- BullMQ is a Redis-based queue for Node.js; NestJS integrates it through the official `@nestjs/bullmq` package (`BullModule.forRoot`/`BullModule.registerQueue` + `@Processor` decorator). Jobs are added to a named queue and consumed by worker providers registered in a NestJS module.
- **Pros:** First-class NestJS integration (DI, decorator-driven processors); declarative retries, backoff, and job concurrency; Redis is one lightweight container; BullMQ is the de-facto standard for NestJS background jobs; failed jobs land in a retriable state and can be re-queued; the worker shares entities/config with the API within the same monorepo.
- **Cons:** Adds Redis as new infrastructure (one container); at-least-once delivery (processing must be idempotent); Redis memory constraints for very large job graphs (not relevant at this scale).

### Option B: RabbitMQ (`@golevelup/nestjs-rabbitmq`)
- A full AMQP message broker with exchange/topic semantics, routing keys, durable queues, and ACK/NACK.
- **Pros:** Battle-tested broker with flexible routing (exchanges, dead-letter exchange), priority queues; language-agnostic for future non-Node consumers; native persistent messages.
- **Cons:** Heavier infrastructure (Erlang runtime, routing topology); community NestJS wrapper is less established than the official BullMQ integration; retries/backoff must be implemented manually.

### Option C: Redis Streams (raw client)
- Publish events to a Redis Stream with one consumer group per worker; no scheduling/retry layer on top.
- **Pros:** No dependency beyond Redis; full control.
- **Cons:** No built-in retries, backoff, cron scheduling, or dead-letter handling — all hand-rolled; no NestJS integration; larger surface to test and maintain.

**Recommendation:** **Option A (BullMQ + Redis via `@nestjs/bullmq`)** — Redis is minimal infrastructure, the `@nestjs/bullmq` pattern fits the project's NestJS-native conventions (`@Processor` providers, `BullModule.forRoot/registerQueue` in the module), and declarative retries/backoff cover the processing-failure path with little code. RabbitMQ's richer routing is unnecessary for a single processing queue while adding operational weight.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

**Revisions:**
- 2026-09-07 — Pinned `@nestjs/bullmq@^11.0.0` (CJS) instead of `@^12`. Rationale: v12 ships as ESM-only (`type: module`), which the project's CJS ts-jest stack cannot transform for the test suite; v11 exposes the same `WorkerHost`/`process(job)` processor API and compiles cleanly.

---

## TD-02: Upload Strategy for Files up to 10GB

**Scope:** Backend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" e "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** The phase must support 10GB uploads without blocking the API or holding a request open — the API must not act as an upload proxy. This is a cross-component protocol between the client, the API, and object storage: the API issues a session (draft video + presigned URLs), the client streams the bits directly to MinIO, then the API acknowledges completion and enqueues processing.

**Options:**

### Option A: Presigned S3 multipart upload session (CreateMultipartUpload / UploadPart / CompleteMultipartUpload)
- The client calls `POST /videos` to create a `draft` video + its unique storage key; the API responds with a presigned `CreateMultipartUpload` URL (and the resulting `UploadId`), a list of presigned `UploadPart` URLs so the client can stream its chosen chunks directly to MinIO, and presigned `CompleteMultipartUpload`/`AbortMultipartUpload` URLs. The client streams parts straight to storage (bypassing the API entirely); on finish it calls `POST /videos/:id/complete`, where the API validates the object (HEAD) and enqueues processing.
- **Pros:** The API never touches file bytes — a 10GB upload exercises only the client↔storage link; interrupted uploads are resumable by reusing the `UploadId` and re-attempting a failed `UploadPart`; native MinIO/S3 multipart semantics; part size is chosen client-side (within S3 limits) and the part count stays within the 10,000-part ceiling.
- **Cons:** Client complexity (orchestrating parts, calling `CompleteMultipartUpload` with the assembled part list + ETags); needs a completion ack so drafts are not orphaned; presigned URLs must have a bounded `expiresIn` so the exposure window is time-boxed; requires the client to know part boundaries.

### Option B: Resumable chunked upload via the tus protocol (`tus-node-server` / `tus` client)
- The client uploads a file in chunks to a tus server, which stores parts to a configured storage backend and emits a "finalized" event.
- **Pros:** Truly resumable (network tolerant); battle-tested client libraries; no multipart handshake on the client.
- **Cons:** Requires hosting a tus server (another service) or embedding it in the API (huge files would then flow through Node again — the anti-pattern); wiring tus's S3 driver to MinIO keeps another piece of moving parts; the *direct-to-storage* goal is only met if the tus server writes parts to MinIO, still adding infra that the spec wants exercised in compose and covered by CI.

### Option C: Upload through the API (Express `multer` / proxy)
- Chunk the file into the API then forward to storage; e.g. a `/upload` endpoint with `multer` or `Transfer-Encoding: chunked`.
- **Pros:** Simplest client contract (plain multipart POST to the API); auth reuses the API's JWT guard.
- **Cons:** The API becomes the bytes-bound data path — exactly what the phase forbids ("10GB sem travar"); Node streams buffer memory while proxying a 10GB body; no resumability after a failure (the whole upload restarts); scales the API on a data path it should not own.

### Option D: Presigned single-part `PutObject` (one request)
- The API returns a presigned `PutObject` URL and the client uploads the whole object in one `PUT`.
- **Pros:** Simplest direct-to-storage path; no multipart state.
- **Cons:** A single S3 `PutObject` is limited to 5GB (5GiB); a 10GB object would have to use multipart — so single-part alone does not meet the 10GB requirement.

**Recommendation:** **Option A (presigned S3 multipart session)** — It satisfies the 10GB requirement while keeping the data path out of Node (no API buffering), stays 100% in the S3 API that MinIO (dev) and S3 (prod) share, and the session state is owned by the `draft` video created at the first request. The heavier client-side orchestration belongs to the later-phase frontend; the API exposes the session and completion endpoints.

**Decision:** A (Presigned multipart upload session, client→MinIO direct)

---

## TD-03: Object Storage Blueprint (bucket/key layout, MinIO)

**Scope:** Backend

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** Object storage is decided as S3-compatible (MinIO in dev). The decision here is how to organize buckets and keys and which AWS packages to use, keeping a straight port between MinIO (dev) and S3 (prod). Both video files and thumbnails are served, and objects stay private (every read is a presigned URL).

**Options:**

### Option A: Single bucket `streamtube`, key namespace by object kind (`videos/{videoId}/source.mp4`, `videos/{videoId}/thumbnail.jpg`)
- One bucket; object kinds are distinguished by key prefix.
- **Pros:** No multi-bucket bootstrap in compose/MinIO seeding (one bucket to create); prefix-based naming is easy to reason about and debug; identical between MinIO and AWS; lifecycle/retention policies target prefixes.
- **Cons:** Bucket-wide configuration applies to both kinds (no per-kind retention bucket) — irrelevant at this phase's scale.

### Option B: Per-kind buckets (`videos`, `thumbnails`)
- **Pros:** Hard separation, per-bucket lifecycle rules.
- **Cons:** More bootstrap in MinIO (one bucket per kind to seed); the presigned flow must route each object type to its own bucket — extra plumbing and branching.

### Option C: No kind namespace — single flat key (`/{videoId}/source.mp4`)
- **Pros:** Simpler key building.
- **Cons:** Mixes sources and thumbnails into one pool; no clean way to enumerate "all thumbnails"; weak key organization.

**Recommendation:** **Option A (single `streamtube` bucket, `videos/{videoId}/...` keys)** — For a first video phase, one bucket + structured keys is the simplest S3/MinIO-portable layout. Thumbnails live under `videos/{videoId}/thumbnail.{ext}` (and later custom thumbnails reuse the same key-namespace concept). Bucket stays private; every read is a presigned GET.

**Decision:** A (single `streamtube` bucket; keys `videos/{videoId}/{kind}.{ext}`)

### AWS SDK package set (fixing libraries): `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage` (used by the worker for direct S3 object operations). The `S3Client` is configured with `endpoint`, `region`, `credentials`, and `forcePathStyle: true` (required by MinIO) sourced from config.

---

## TD-04: Video Processing Worker (FFmpeg / ffprobe, process split)

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** After upload completes, a background job must (a) extract duration and metadata (codec, resolution, size) via `ffprobe`, (b) generate a thumbnail from a frame via `ffmpeg`, writing the metadata to the DB and the thumbnail to storage. The decision is how the worker runs and how it drives FFmpeg.

**Options:**

### Option A: Dedicated NestJS worker process in the same repo, FFmpeg binary baked into its container
- Add a `video-worker` Compose service built from the project image (extended to install `ffmpeg`), whose entrypoint bootstraps a NestJS app that consumes the BullMQ `video-processing` queue via `@Processor`. The worker uses `node:child_process` to spawn `ffprobe`/`ffmpeg`, the AWS SDK for object I/O, and TypeORM to update the video row.
- **Pros:** One `docker compose up` starts everything; the worker shares entities/repos/config with the API (same monorepo/tsconfig); BullMQ provides retries/backoff natively; ffmpeg is an apt install with no native-node compile step; worker lifecycle is standard NestJS.
- **Cons:** Worker shares the API's types/entities — module boundaries must be observed so the worker graph contains only what it needs (Video entity + storage + ffmpeg), not the HTTP surface; two entrypoints from one repo (acceptable).

### Option B: Separate worker repository
- **Pros:** Full isolation.
- **Cons:** Duplicating models/repos; more ops; diverges from the monorepo; warranted only if the worker were in another language — no near-term gain here.

### Option C: Lambda / serverless (S3-triggered function)
- **Pros:** Zero servers, automatic scale.
- **Cons:** Not reproducible in local dev (the spec wants all infra in compose); cold starts on large files; pay-per-execution cost for big media; breaks the "everything up via compose" requirement.

### Option D: API itself spawns ffmpeg synchronously on completion
- **Pros:** Simplest wiring; no extra process.
- **Cons:** Video processing is CPU/IO-heavy and holds the API process — violates "sem travar o sistema", removes isolation, and merges worker load with request handling.

**Recommendation:** **Option A (dedicated NestJS worker container in the same repo)** — The worker consumes `video-processing`, spawns `ffprobe`/`ffmpeg`, and updates the video row + thumbnail. `video-worker` runs the same image under `npm run start:worker`; ffmpeg is installed via the Dockerfile. ffprobe parses metadata (JSON → duration/resolution/codec) and a single `ffmpeg` invocation writes the thumbnail to the storage key.

**Decision:** A (NestJS worker process + ffmpeg/ffprobe in its container)

---

## TD-05: Unique Video URL

**Scope:** Backend

**Capability:** "URL única por vídeo, sem conflito com outros vídeos"

**Context:** Each video gets a short, unique, public identifier that never collides with another video. This identifier appears in the video page URL (`/videos/abcd1234xyz`) and in storage-key references.

**Options:**

### Option A: Short base-62 id stored in a `unique_id` column (indexed, unique)
- Generate `crypto.randomBytes(8)` → encode to base-62, ≈ 11–12 URL-safe characters; store in a `unique_id` column with a unique index. On the rare `23505` collision, re-roll.
- **Pros:** Short and URL-safe; collision-resilient over 64 bits; independent of filename/title (no slug conflicts on rename); fits the spec's "URL curta e única" point.
- **Cons:** Slightly more entropy than needed (trivial).

### Option B: Full UUIDv4 as the public id (`/videos/<uuid>`)
- **Pros:** Globally unique, zero extra code.
- **Cons:** Long URLs (36 chars); not the "short URL" spirit of the spec.

### Option C: Memorable slug from the title
- **Pros:** Pretty URLs.
- **Cons:** Collisions on common titles; breaks when the title is edited (renames URLs); not a stable shareable handle.

**Recommendation:** **Option A (base-62 short id in a unique `unique_id` column)** — Short, URL-safe, and conflict-free without the slug-management pain of Option C.

**Decision:** A (base-62 short id in dedicated `unique_id` column)

---

## TD-06: Video Playback & Download Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem exigir o download completo)", "Download do vídeo pelo usuário"

**Context:** How playback and download are delivered. A "stream without full download" has two viable channels: (a) the API reverse-proxies bytes with Range handling, or (b) the API hands the client a presigned object URL that supports HTTP Range requests (MinIO answers `206 Partial Content`) with a `response-content-disposition` override to trigger a download.

**Options:**

### Option A: Presigned GET URL (Range / 206 served by storage)
- The API returns a presigned `GetObject` URL (bounded `expiresIn`) pointing at MinIO; the player streams with normal `Range` headers; MinIO answers `206 Partial Content`; for download the presigned URL carries `response-content-disposition=attachment&filename=...` so the browser saves it.
- **Pros:** Zero API bytes/bandwidth; single mechanism for stream + download + thumbnails; MinIO/S3 Range is robust; no custom streaming code; trivially horizontally scalable.
- **Cons:** The playback client accepts a storage-host URL (allow-listed in the later frontend); access control is by signature lifetime (acceptable for a transient playback link).

### Option B: API reverse-proxy range endpoint (`GET /videos/:id/stream`)
- **Pros:** Domain-controlled URL; auth on every request.
- **Cons:** Every byte flows through Node (10GB over a session) — contradicts "sem travar o sistema"; Range/206 parsing, seek buffering, and memory use must be implemented; multiplies with instances.

### Option C: Public storage bucket (no signing)
- **Pros:** Trivial.
- **Cons:** No access control; leaks object keys; violates the private-by-default intent.

**Recommendation:** **Option A (presigned GET, Range/206 via MinIO)** — Presigned URLs give 206 partial content for player seeks, `Content-Disposition` for downloads, and keep the bucket private. The playback contract is `GET /videos/:id/play-url` → `{ url, expires }`.

**Decision:** A (presigned S3 GET; Range/206 and download served by MinIO)

---

## TD-07: Video Status Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", and the error path implied by "status (ex.: rascunho → processando → pronto/erro)".

**Context:** The lifecycle (`draft → processing → ready | failed`) must persist in the DB and gate both the API (which endpoints are reachable when) and the worker (what it transitions to). The error path must be managed: retries, then a final `failed` state with a reason — no silent orphans.

**Options:**

### Option A: Enum states + BullMQ retries
- `status` is a DB enum (`draft | processing | ready | failed`). The API creates the `draft`; on completion it enqueues a job. The worker moves the row to `processing`, then to `ready` (with duration/metadata/thumbnail key) on success or, on failure, relies on BullMQ's `attempts`/`backoff` and finally sets `failed` + `processing_error`. API endpoints gate on status (only `ready` videos stream/play).
- **Pros:** Simple and easy to reason about; BullMQ retries are built-in; matches the spec's required states; a `failed` video can be re-processed by enqueuing again (the worker re-runs on the same row).
- **Cons:** No full status-history audit trail; retries must be idempotent on the worker side.

### Option B: Explicit status-history table (`video_status_events`)
- Every transition recorded (status, actor, timestamp).
- **Pros:** Audit trail.
- **Cons:** Extra table and writes; the phase does not require a full audit trail.

### Option C: Event-sourced state machine (e.g. XState) in the worker
- **Cons:** Over-engineering; a library managing queue+DB state adds complexity with no benefit here. Rejected.

**Recommendation:** **Option A (enum states + BullMQ retry policy)** — Matches the required states, reuses BullMQ's `attempts: 3, backoff: 'exponential'`, and leaves `failed` videos re-processable. On success the worker stores `duration_seconds`, `width`, `height`, `codec`, `thumbnail_key`.

**Decision:** A (enum `draft → processing → ready | failed`; BullMQ `attempts: 3` with exponential backoff; final `failed` + `processing_error`)

---

## TD-08: Video Entity Shape

**Scope:** Backend

**Capability:** Transversal — persists "identificação, dono (canal), título, status, chaves de storage do arquivo e do thumbnail, duração e metadados, e o identificador da URL única" ("Persistência" of the spec).

**Context:** The spec enumerates the minimum columns for the videos table. This TD pins the exact entity fields so the migration and the module agree.

**Options:**

### Option A: Canonical `videos` table with fields materialized directly
- Columns: `id` (uuid PK), `channel_id` (uuid FK → channels), `title` (varchar), `unique_id` (short base-62, unique index), `status` (DB enum `draft|processing|ready|failed`), `storage_key` (the MinIO object key for the source), `size_bytes` (bigint, from multipart completion), `content_type`, `duration_seconds`, `width`, `height`, `codec`, `thumbnail_key` (object key), `processing_error` (text, nullable), `created_at`/`updated_at`. Many-to-one to `Channel`.
- **Pros:** One row per video; simple queries, simple SIs; derived metadata filled by the worker.
- **Cons:** A wide row — fine at this scale.

### Option B: Normalized metadata in a 1:1 `video_metadata` table
- **Cons:** Extra JOIN, no benefit here.

**Recommendation:** **Option A (single `videos` table)** — snake_case columns matching the project's entity conventions, with `status` as a real PostgreSQL enum type, a unique index on `unique_id`, and an FK on `channel_id`.

**Decision:** A (single `videos` table with draft/processing/ready/failed + worker-derived fields)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis (`@nestjs/bullmq`) | A (BullMQ + Redis) |
| TD-02 | Backend | Upload Strategy (10 GB) | Presigned S3 multipart (client → MinIO) | A (Presigned multipart) |
| TD-03 | Backend | Storage Layout (bucket/keys) | Single `streamtube` bucket, `videos/{videoId}/...` keys | A (single bucket + prefixes) |
| TD-04 | Backend | Video Worker (FFmpeg) | Dedicated NestJS worker process (same repo) + ffmpeg | A (NestJS worker) |
| TD-05 | Backend | Unique Video URL | base-62 short id in `unique_id` column | A (base-62 short id) |
| TD-06 | Backend | Stream & Download | Presigned GET URL (Range 206 + Content-Disposition) | A (presigned URLs) |
| TD-07 | Backend | Status Lifecycle & Failure | enum `draft→processing→ready/failed`; BullMQ retry×3 | A (enum + retry) |
| TD-08 | Backend | Video entity shape | single `videos` table with processing fields | A (single table) |
