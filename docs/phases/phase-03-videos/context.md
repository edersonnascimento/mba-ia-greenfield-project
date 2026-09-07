---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-07T13:13:12-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-07T13:33:24-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-09-07T13:13:12-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-07T13:13:12-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Comments, likes, subscriptions, search, home feed, channel public page, and video management/editing UI (Fases 04–07).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas — entregue como backend + infra (MinIO, Redis, FFmpeg worker) via `docker compose`.

**Affected subprojects:** `nestjs-project/` — new `videos/` module, migration, object-storage client, BullMQ queue integration, dedicated FFmpeg worker process, and new Compose services.

**Deferred subprojects:** `next-frontend/` — the video upload/playback interface (player, upload UI) is explicitly out of scope for this phase (the `interface de vídeo não faz parte do escopo desta fase`).

**Sequencing notes:** Depends on Fase 02 (users, channels, auth already implemented). The `videos` entity references the `channels` table via FK. Auth (JWT guard) protects the authenticated video endpoints; anonymous access is allowed for streaming/download via presigned URLs (see TD-06).

**Neighbors (for boundary detection only):**

- **Phase 02 (prior):** auth lifecycle, users, channels, JWT guard, domain exception filter, ValidationPipe, migrations/seeds — all inherited as conventions.
- **Phase 04 (next):** video management, draft→publish flow, custom thumbnail, channel admin panel.

## Decisions Index

_(from decisions doc `docs/decisions/technical-decisions-phase-03-videos.md`)_

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq, bullmq, ioredis |
| phase-03-videos/TD-02 | phase | Backend | Upload Strategy (10 GB) | decided | A (Presigned multipart) | @aws-sdk/s3-request-presigner, @aws-sdk/client-s3 |
| phase-03-videos/TD-03 | phase | Backend | Storage Layout (bucket/keys) | decided | A (single `streamtube` bucket) | @aws-sdk/client-s3 |
| phase-03-videos/TD-04 | phase | Backend | Video Worker (FFmpeg) | decided | A (NestJS worker + ffmpeg) | @nestjs/bullmq |
| phase-03-videos/TD-05 | phase | Backend | Unique Video URL | decided | A (base-62 short id) | — |
| phase-03-videos/TD-06 | phase | Backend | Stream & Download | decided | A (presigned GET, Range 206) | @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-07 | phase | Backend | Status Lifecycle & Failure | decided | A (enum + retry×3) | bullmq job options |
| phase-03-videos/TD-08 | phase | Backend | Video entity shape | decided | A (single `videos` table) | typeorm |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-07, phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-07, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-08 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis via `@nestjs/bullmq`) — Redis is minimal infrastructure, the `@nestjs/bullmq` pattern fits the project's NestJS-native conventions (`@Processor` providers, `BullModule.forRoot/registerQueue` in the module), and declarative retries/backoff cover the processing-failure path with little code. RabbitMQ's richer routing is unnecessary for a single processing queue while adding operational weight.
**Libraries:** @nestjs/bullmq, bullmq, ioredis

### phase-03-videos/TD-02

**Recommendation:** Option A (presigned S3 multipart session) — It satisfies the 10GB requirement while keeping the data path out of Node (no API buffering), stays 100% in the S3 API that MinIO (dev) and S3 (prod) share, and the session state is owned by the `draft` video created at the first request. The heavier client-side orchestration belongs to the later-phase frontend; the API exposes the session and completion endpoints.
**Libraries:** @aws-sdk/s3-request-presigner, @aws-sdk/client-s3

### phase-03-videos/TD-03

**Recommendation:** Option A (single `streamtube` bucket, `videos/{videoId}/...` keys) — For a first video phase, one bucket + structured keys is the simplest S3/MinIO-portable layout. Thumbnails live under `videos/{videoId}/thumbnail.{ext}` (and later custom thumbnails reuse the same key-namespace concept). Bucket stays private; every read is a presigned GET.
**Libraries:** @aws-sdk/client-s3

### phase-03-videos/TD-04

**Recommendation:** Option A (dedicated NestJS worker container in the same repo) — The worker consumes `video-processing`, spawns `ffprobe`/`ffmpeg`, and updates the video row + thumbnail. `video-worker` runs the same image under `npm run start:worker`; ffmpeg is installed via the Dockerfile. ffprobe parses metadata (JSON → duration/resolution/codec) and a single `ffmpeg` invocation writes the thumbnail to the storage key.
**Libraries:** @nestjs/bullmq

### phase-03-videos/TD-05

**Recommendation:** Option A (base-62 short id in a unique `unique_id` column) — Short, URL-safe, and conflict-free without the slug-management pain of Option C.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Option A (presigned GET, Range/206 via MinIO) — Presigned URLs give 206 partial content for player seeks, `Content-Disposition` for downloads, and keep the bucket private. The playback contract is `GET /videos/:id/play-url` → `{ url, expires }`.
**Libraries:** @aws-sdk/s3-request-presigner

### phase-03-videos/TD-07

**Recommendation:** Option A (enum states + BullMQ retry policy) — Matches the required states, reuses BullMQ's `attempts: 3, backoff: 'exponential'`, and leaves `failed` videos re-processable. On success the worker stores `duration_seconds`, `width`, `height`, `codec`, `thumbnail_key`.
**Libraries:** bullmq job options

### phase-03-videos/TD-08

**Recommendation:** Option A (single `videos` table) — snake_case columns matching the project's entity conventions, with `status` as a real PostgreSQL enum type, a unique index on `unique_id`, and an FK on `channel_id`.
**Libraries:** typeorm

## Inherited Decisions Detail

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** argon2@^0.41.x

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Libraries:** @nestjs/jwt@^11.0.0
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller.

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** @nestjs-modules/mailer@^2.x, handlebars@^4.x

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** class-validator@^0.14.x, class-transformer@^0.5.x

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** @nestjs/throttler@^6.x

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Libraries:** @nestjs/jwt@^11.0.0
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`).

### phase-02-auth/TD-10

**Recommendation:** Option A — `[a-z0-9_]` allowlist with `user_<8-char-random>` fallback when the prefix yields an empty string.
**Libraries:** —

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.
**Libraries:** @nestjs/config@^4.x

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.
**Libraries:** joi@^17.x

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** dotenv (transitive via @nestjs/config)

## Inherited Conventions

_(from phase 01 — config/conventions; reused in phase 02 and inherited here)_

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g. TypeORM CLI). _(from phase 01)_
- `src/database/data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Entities use `@Entity('snake_case_name')`, snake_case columns, `uuid` PK generated by `uuid4`, `@CreateDateColumn`/`@UpdateDateColumn` for timestamps, unique constraints via `@Index`/`@Unique`. _(from phase 02)_
- Errors follow the domain-exception contract `{ statusCode, error, message }` with a domain `error` code; `DomainExceptionFilter` (global) and `ValidationExceptionFilter` for class-validator. _(from phase 02)_
- JWT auth uses custom guards (`JwtAuthGuard` via `APP_GUARD`) + `@nestjs/jwt`, with `@Public()` to opt out; protected endpoints default to authenticated. _(from phase 02)_
- DTOs use `class-validator` decorators, applied by the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`). _(from phase 02)_
- Compose uses **service names** as hosts (never `localhost`); all infra services defined in `nestjs-project/compose.yaml`; `nestjs-api` waits on `db` via healthcheck condition `service_healthy`. _(from phase 02)_
- Migrations are TypeORM 0.3 scripts in `src/database/migrations/`, run via `npm run migration:run`; `synchronize: false` in prod path. _(from phase 02)_
- Tests use suffixes `*.spec.ts` (unit), `*.integration-spec.ts` (DB/services), `*.e2e-spec.ts` (supertest, in `test/`); e2e and integration run `--runInBand` against the shared test DB; jest config has `setupFiles: ['dotenv/config']`. _(from phase 02)_
- Build assets (templates, etc.) declared in `nest-cli.json` `compilerOptions.assets`. _(from phase 02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| Video management / edit / publish (draft→publish, custom thumbnail, channel panel) | deferred | Fase 04 | — |
| Video watch page (player, description, suggestions, likes/comments) | deferred | Fase 05/06 | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces an entity/table, a storage client, a queue producer, and a background worker — each layer is exercised by unit, integration (DB + MinIO + Redis), and E2E tests per the testing guide's pyramid. Specific layer coverage by SI is recorded in `progress.md`.

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity / Repository (video, storage config) | Unit (`*.spec.ts` with mocked repo), Integration (`*.integration-spec.ts` against real `db`) |
| Storage client (S3 presigned / multipart) | Unit (mocked S3), Integration (against real `minio` in compose) |
| Queue producer (enqueue / retry config) | Unit (mocked `Queue`), Integration (against real `redis`) |
| Worker processor (`@Processor`) | Unit (mocked child_process + storage + repo), Integration (against real `redis` + `db`; ffmpeg invoked as a real binary on a tiny fixture) |
| Controller (upload session, complete, play-url, download) | Unit (mocked service), E2E (`*.e2e-spec.ts` via supertest against auth-protected routes) |
| Migrations | Integration (`*.integration-spec.ts` runs migrations against `db` and asserts tables) |

### next-frontend

_Deferred — testing requirements will be defined when the frontend is in scope._
