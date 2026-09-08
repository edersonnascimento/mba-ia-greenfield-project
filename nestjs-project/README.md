# StreamTube — Backend API (NestJS)

Backend de **StreamTube** — plataforma de compartilhamento de vídeos. Parte do monorepo `mba-ia-greenfield-project` (frontend em `next-frontend/`).

Stack: **NestJS 11** + **TypeScript** (strict) + **TypeORM** / **PostgreSQL 17**, **JWT + Argon2** (authenticação), **MinIO** (object storage S3-compatible), **Redis + BullMQ** (fila de processamento) e **FFmpeg** (worker de vídeo).

---

## 🚀 Setup (Docker)

Todo roda em containers. Os comandos `npm`/`npx` rodan**dentro do container** `nestjs-api`, nunca no host (divergência de env vars e versões de Node).

```bash
cd nestjs-project

# Sobe API, banco, Mailpit, MinIO (object storage), Redis (fila) e video-worker
docker compose up -d

# Instala dependências (apenas na primeira vez)
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe o servidor de desenvolvimento em watch mode
docker compose exec -d nestjs-api npm run start:dev

# Sobe o worker de vídeo (consume a fila `video-processing`)
docker compose up video-worker          # (ou: docker compose exec -d video-worker npm run start:worker)
```

### Servicios

| Servicio | URL / Porta |
|----------|-------------|
| API NestJS | http://localhost:3000 |
| video-worker | interno — consome a fila `video-processing` (sem porta exposta) |
| PostgreSQL | `localhost:5432` (db/usuário/senha: `streamtube`) |
| MinIO (API S3) | http://localhost:9000 — console: http://localhost:9001 (user/key: `minioadmin`) |
| Redis (fila BullMQ) | `localhost:6379` |
| Mailpit (UI de e-mails) | http://localhost:8025 |
| Swagger (opcional) | http://localhost:3000/api/docs — habilite com `SWAGGER_ENABLED=true` |

Config via env vars: `DB_*`, `JWT_*`, `MAIL_*`, `S3_*`, `REDIS_*`, `QUEUE_*` (ver `.env.example`). **Dentro dos containers, use sempre o nome do serviço do Compose como host** (`db`, `minio`, `redis`), nunca `localhost`.

---

## 📁 Estrutura do Módulo

```
src/
├── app.module.ts            # Raíz: ConfigModule (Joi), TypeOrmModule, módulos de domínio
├── main.ts                  # Bootstrap: ValidationPipe (whitelist), filters, Swagger
├── auth/                    # Registro, login, JWT + refresh rotation, confirmación, reset
├── users/                   # Entidade e lógica de usuários
├── channels/                # Canal 1:1 por usuário (nickname do e-mail)
├── videos/                  # Vídeos: draft, upload multipart, streaming/download
│   ├── dto/                 # DTOs de entrada/saída (class-validator + Swagger)
│   ├── entities/            # Entidade Video (tabela `videos`)
│   ├── exceptions/          # DomainException do catálogo VIDEO_*
│   ├── unique-id.util.ts    # Short-id base-62 (`crypto.randomBytes(8)`)
│   └── filename.util.ts     # Ext + título desde filename
├── storage/                 # Cliente S3/MinIO + URLs pre-assinadas (presign)
├── queue/                   # Fila BullMQ + produtor `video-processing`
├── worker/                  # Procesador FFmpeg (ffprobe/ffmpeg) + entrypoint main.worker.ts
├── mail/                    # Envío de e-mails (templates Handlebars)
├── common/                  # Filtros (DomainException/Validation), pipes, exceptions
├── config/                  # Configs namespaced (registerAs + validação Joi)
├── database/                # data-source, migrations versionadas, seeds
└── swagger/                 # OpenAPI (exportable a openapi.json)
```

---

## 🔐 API

Guard global de JWT (`JwtAuthGuard`): **todo endpoint é protegido por padrão**; rotas públicas opt-out com `@Public()` (e.g. `GET /videos/:id/play-url`).

| Método & Rota | Auth | Descrição |
|---------------|------|-----------|
| `POST /auth/register` | Pública | Registro (cria usuário + canal) |
| `GET /auth/confirm-email?token=` | Pública | Confirmação de conta |
| `POST /auth/resend-confirmation` | Pública | Reenvío de confirmação |
| `POST /auth/login` | Pública | Access + refresh token |
| `POST /auth/refresh` | Pública | Rotação de refresh token |
| `POST /auth/logout` | JWT | Revoca refresh tokens |
| `POST /auth/forgot-password` | Pública | Email de recuperação |
| `POST /auth/reset-password` | Pública | Reset via token |
| `GET /auth/me` | JWT | Perfil do usuário autenticado |
| `POST /videos` | JWT (owner) | Pré-registra um `draft` → `storage_key` |
| `POST /videos/:id/uploads` | JWT (owner) | Cria sessão multipart → `upload_id`, `part_size` |
| `POST /videos/:id/uploads/parts` | JWT (owner) | URL pre-assinada `UploadPart` (o cliente envia bytes direto ao MinIO) |
| `POST /videos/:id/uploads/complete` | JWT (owner) | Monta + HEAD verify → `processing` + encola job |
| `POST /videos/:id/uploads/abort` | JWT (owner) | Aborta sessão multipart |
| `GET /videos/:id` | JWT (owner) | Detalle + metadados (`thumbnail_url`, `video_url`) |
| `GET /videos/:id/play-url` | Pública | URL pre-assinada de streaming (Range/206) |
| `GET /videos/:id/download-url` | JWT (qualquer) | URL pre-assinada de download (`Content-Disposition`) |

**Videos — flujo:** `draft → processing → ready | failed`. Upload de até 10 GB **sem passar bytes pela API**: o cliente envia cada parte via presigned `UploadPart` directo ao bucket `streamtube`. Um `video-worker` consome a fila `video-processing` (BullMQ/Redis), extrai duração/metadados (`ffprobe`), gera o thumbnail (`ffmpeg`, `videos/{unique_id}/thumbnail.jpg`) e atualiza o estado.

Catálogo de erros de domínio: `VIDEO_NOT_FOUND`/`VIDEO_FORBIDDEN`/`VIDEO_INVALID_STATUS`/`VIDEO_NOT_READY`/`VIDEO_OBJECT_VERIFICATION_FAILED` — mapeados por `DomainExceptionFilter` ao envelope padrão `ApiErrorEnvelope`.

Swagger em `/api/docs` (com `SWAGGER_ENABLED=true`) e export OpenAPI: `npm run openapi:export`.

---

## ✅ Comandos

### Desenvolvimento / build

| Comando | Descrição |
|---------|-----------|
| `npm run start:dev` | Dev server com hot-reload |
| `npm run start:worker` | Worker de vídeo (ffprobe/ffmpeg, fila) |
| `npm run build` / `npm run start:prod` | Compilar / rodar dist |
| `npm run migration:run` | Aplica migraciones (obrigatório — synchronize off) |
| `npm run migration:revert` / `migration:generate` | Revertir / gerar migração |
| `npm run seed` | Sembrar dados |
| `npm run openapi:export` | Exporta `openapi.json` (contrato do frontend) |

### Qualidade

```bash
npx tsc --noEmit      # Type-check (DoD: exit 0)
npm run lint          # ESLint (--fix)
npm run format        # Prettier
```

### Tests

Sufixos (contrato, configura o agendamento do Jest):
- `*.spec.ts` — unitário (colaboradores mockeados, sem I/O)
- `*.integration-spec.ts` — integração (banco/Redis/MinIO reais via Compose)
- `*.e2e-spec.ts` — end-to-end (HTTP via supertest, em `test/`)

```bash
docker compose exec nestjs-api npm test                 # unitário + integração
docker compose exec nestjs-api npm test -- --runInBand  # integração/e2e: SEMPRE com --runInBand (DB compartida)
docker compose exec nestjs-api npm run test:e2e         # end-to-end
docker compose exec nestjs-api npm run test:cov         # cobertura
```

> Integração e e2e compartem DATABASE de test e **devem** rodar com `--runInBand`; em paralelo causam violações de FK/deadlocks.

---

## 🧱 Convenções

- **Camadas:** Controllers finos (HTTP + Swagger) → Services (regras de negócio, lançam `DomainException`) → repository/TypeORM. Sem `try/catch` em controllers.
- **DTOs:** `class-validator` na entrada; resposta com DTOs dedicados (nunca expor entidades). Swagger via plugin CLI (`introspectComments`); `@ApiProperty` só onde o plugin não infiere (response DTOs, unions).
- **Config:** namespaced com `registerAs` + esquema Joi em `env.validation.ts`.
- **Migrations:** versionadas (`<timestamp>-Name.ts`), `synchronize: false` em runtime.

Convenções completas em `.claude/rules/*.md` da raíz e `nestjs-project/CLAUDE.md`.