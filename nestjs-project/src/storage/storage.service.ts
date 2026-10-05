import {
  AbortMultipartUploadCommand,
  CompletedPart,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

export interface ObjectHead {
  size: number;
  etag?: string;
}

@Injectable()
export class StorageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly cfg: ConfigType<typeof storageConfig>,
  ) {}

  private getClient(): S3Client {
    if (this.client) return this.client;
    this.client = new S3Client({
      region: this.cfg.region,
      credentials: {
        accessKeyId: this.cfg.accessKey,
        secretAccessKey: this.cfg.secretKey,
      },
      endpoint: this.cfg.endpoint,
      forcePathStyle: true,
    });
    return this.client;
  }

  private isBucketExistsError(err: unknown): boolean {
    const metadata = (err as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata;
    return metadata?.httpStatusCode === 409;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.getClient().send(
        new CreateBucketCommand({ Bucket: this.cfg.bucket }),
      );
    } catch (err) {
      if (!this.isBucketExistsError(err)) throw err;
    }
  }

  async createMultipart(key: string): Promise<string> {
    const response = await this.getClient().send(
      new CreateMultipartUploadCommand({ Bucket: this.cfg.bucket, Key: key }),
    );
    return response.UploadId ?? '';
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<void> {
    const completed: CompletedPart[] = parts.map((p) => ({
      ETag: p.etag,
      PartNumber: p.partNumber,
    }));
    await this.getClient().send(
      new CompleteMultipartUploadCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completed },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.getClient().send(
      new AbortMultipartUploadCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<ObjectHead> {
    const response = await this.getClient().send(
      new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
    );
    return { size: Number(response.ContentLength ?? 0), etag: response.ETag };
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.getClient(),
      new UploadPartCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.cfg.presignedUrlTtlSeconds },
    );
  }

  async presignPut(key: string): Promise<string> {
    return getSignedUrl(
      this.getClient(),
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      { expiresIn: this.cfg.presignedUrlTtlSeconds },
    );
  }

  async presignCreateMultipart(key: string): Promise<string> {
    return getSignedUrl(
      this.getClient(),
      new CreateMultipartUploadCommand({
        Bucket: this.cfg.bucket,
        Key: key,
      }),
      { expiresIn: this.cfg.presignedUrlTtlSeconds },
    );
  }

  async presignCompleteMultipart(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<string> {
    const completed: CompletedPart[] = parts.map((p) => ({
      ETag: p.etag,
      PartNumber: p.partNumber,
    }));
    return getSignedUrl(
      this.getClient(),
      new CompleteMultipartUploadCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completed },
      }),
      { expiresIn: this.cfg.presignedUrlTtlSeconds },
    );
  }

  async presignAbortMultipart(key: string, uploadId: string): Promise<string> {
    return getSignedUrl(
      this.getClient(),
      new AbortMultipartUploadCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        UploadId: uploadId,
      }),
      { expiresIn: this.cfg.presignedUrlTtlSeconds },
    );
  }

  async readStream(key: string): Promise<NodeJS.ReadableStream> {
    const response = await this.getClient().send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
    );
    return response.Body as NodeJS.ReadableStream;
  }

  async presignGet(
    key: string,
    options: { disposition?: string } = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      ResponseContentDisposition: options.disposition,
    });
    return getSignedUrl(this.getClient(), command, {
      expiresIn: this.cfg.presignedUrlTtlSeconds,
    });
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType?: string,
  ): Promise<void> {
    await this.getClient().send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureBucket();
    } catch (err) {
      this.logger.error(
        `Failed to ensure storage bucket "${this.cfg.bucket}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
