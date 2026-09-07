import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const logger = new Logger('Worker');
  const app = await NestFactory.create(WorkerModule);
  const port = Number(process.env.WORKER_PORT || 3001);
  await app.listen(port);
  logger.log(`Video worker listening on ${port}`);
}

void bootstrap();
