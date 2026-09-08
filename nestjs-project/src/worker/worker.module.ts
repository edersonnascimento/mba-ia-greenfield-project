import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { envValidationSchema } from '../config/env.validation';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoQueueEventsListener } from './video-queue-events.listener';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    StorageModule,
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.redisHost, port: cfg.redisPort },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    TypeOrmModule.forFeature([Video]),
  ],
  providers: [
    VideoProcessingProcessor,
    FfmpegService,
    VideoQueueEventsListener,
  ],
})
export class WorkerModule {}
