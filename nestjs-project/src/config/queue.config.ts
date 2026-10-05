import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  videoProcessingQueue:
    process.env.QUEUE_VIDEO_PROCESSING || 'video-processing',
  attempts: parseInt(process.env.QUEUE_ATTEMPTS || '3', 10),
}));
