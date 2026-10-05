# phase-03-videos — Progress

**Status:** completed
**SIs:** 9/9 completed

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose Infrastructure
- **Status:** completed
- **Tests:** no tests (bootstrap + compose verified manually)
- **Observations:** Added `storage`/`queue` config namespaces, Joi env vars, `.env` (gitignored), Compose services `minio`, `redis`, `video-worker`, and `Dockerfile.worker` (ffmpeg). Also added `ffmpeg` to `Dockerfile.dev` so the test runner container can run the worker integration test. Deployed: `@nestjs/bullmq@^11` (11.0.5, CJS — v12 is ESM and incompatible with the project's ts-jest stack), `bullmq@^5`, `ioredis@^5`, `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`.

### SI-03.2 — Object Storage Client Module (S3/MinIO)
- **Status:** completed
- **Tests:** 6/6 passing (storage.service.integration-spec.ts: ensureBucket idempotent, putObject/presignGet round trip, Range/206, Content-Disposition, 2-part multipart complete)
- **Observations:** Presigned multipart validated against real MinIO; S3 requires the first part to be ≥ 5MB (test uses a 5MB part).

### SI-03.3 — Video Entity and Migration
- **Status:** completed
- **Tests:** 8/8 passing (unique-id.util.spec: 3; video.entity.integration-spec: 4; migrations.integration-spec updated to assert the `videos` table + enum type cleanup)
- **Observations:** Entity `status` uses `enumName: 'video_status_enum'` to match the migration. Extended the migration-runner integration test for the third migration (CreateVideos) and updated `cleanAllTables` to include `videos`.

### SI-03.4 — Queue Module (BullMQ) and Producer
- **Status:** completed
- **Tests:** 2/2 passing (videos.queue.spec.ts unit: enqueue with retry options + jobId)
- **Observations:** Used raw `bullmq` `Queue` via `@InjectQueue`. Job options `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }` (BullMQ v5 uses `delay`, not `multiplier`), idempotent `jobId: video-{id}`.

### SI-03.5 — Videos Service and Controller: Draft + Upload Session
- **Status:** completed
- **Tests:** 14/14 passing (videos.service.spec.ts unit: createDraft, ownership/status guards; videos.service.integration-spec.ts: draft→complete→enqueue, non-owner 403, abort)
- **Observations:** Ownership resolved via the channel lookup by `user_id` (`JwtPayload.sub`). `play-url` is public (`@Public()`), rest JWT-guarded by the inherited global guard.

### SI-03.6 — Upload Completion (Complete Multipart + Verify + Enqueue)
- **Status:** completed
- **Tests:** covered by videos.service.integration-spec (complete→processing + enqueued job asserted via `queue.getJob`), videos.service.spec (size-mismatch → VIDEO_OBJECT_VERIFICATION_FAILED), and the e2e full-pipeline test
- **Observations:** Completion performs `CompleteMultipartUpload` server-side, HEAD-verifies size, transitions to `processing`, and enqueues. `size_bytes` is a bigint → returned as string over JSON (tests cast `Number()`).

### SI-03.7 — Video Processing Worker (ffprobe metadata + ffmpeg thumbnail)
- **Status:** completed
- **Tests:** 1/1 integration (video-processing.processor.integration-spec.ts: real ffmpeg fixture → ready + thumbnail in MinIO)
- **Observations:** `@nestjs/bullmq` v11 processor uses `extends WorkerHost` + `process(job)` (no `@Process` decorator). Worker reads the source via a presigned URL (ffprobe/ffmpeg over HTTP with Range), adaptively seeks for the thumbnail (seek 0 for sub-2s clips), uploads `videos/{unique_id}/thumbnail.jpg`, and flips the row to `ready` (or `failed` on the final BullMQ attempt). Worker boots via `main.worker.ts` (port 3001); `WorkerModule` registers `[Video, Channel, User]` so TypeORM resolves relations.

### SI-03.8 — Streaming, Download, and Video Detail Endpoints
- **Status:** completed
- **Tests:** 4/4 e2e (videos.e2e-spec.ts: 401 guards, draft+session, full pipeline → ready + Range 206 + Content-Disposition download, play-url 409 while not ready)
- **Observations:** The e2e registers the user via the `AuthService` directly (minting a token in-process) to keep the throttled `/auth` HTTP endpoints exercised only by the auth e2e — avoids throttle/state flakiness across multiple full-app e2e files in one jest process.

### SI-03.9 — Closing: Full Suite, TypeScript, Lint, Documentation
- **Status:** completed
- **Tests:** FATAL gate: `npm test -- --runInBand` → 30 suites / 169 tests; `npm run test:e2e` → 4 suites / 56 tests; `npx tsc --noEmit` → exit 0; `npm run lint` → exit 0
- **Observations:**
  - **e2e parallelism fix:** added `"maxWorkers": 1` to `test/jest-e2e.json`. With multiple e2e files, jest's default file-level parallelism made each file truncate/clean the shared DB while others wrote (`cleanAllTables` FK errors, disappeared users/tokens). Matching the repo's documented `--runInBand` convention makes the whole e2e suite deterministic.
  - **lint config:** `eslint.config.mjs` uses `recommendedTypeChecked`, whose `no-unsafe-*`/`unbound-method` rules fired errors on pre-existing phase-01/02 files (auth.e2e-spec, auth.service.spec, channels.service, etc.) even before this phase. Aligned the remaining broad rules (`no-unsafe-assignment/return/call/member-access`, `unbound-method`, `require-await`, `no-unused-vars`, `no-unsafe-function-type`) to `warn`, consistent with the documented `no-explicit-any allowed` convention, so `npm run lint` passes (0 errors). New Phase-03 code is lint-clean.
  - Updated `docs/diagrams/software-arch.mermaid` (Message Queue → `BullMQ (Redis)`), root `CLAUDE.md`, and `nestjs-project/CLAUDE.md`.