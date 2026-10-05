import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.S3_SECRET_KEY || 'minioadmin',
  bucket: process.env.S3_BUCKET || 'streamtube',
  presignedUrlTtlSeconds: parseInt(
    process.env.S3_PRESIGNED_URL_TTL_SECONDS || '3600',
    10,
  ),
  partSize: parseInt(process.env.S3_PART_SIZE || '52428800', 10),
}));
