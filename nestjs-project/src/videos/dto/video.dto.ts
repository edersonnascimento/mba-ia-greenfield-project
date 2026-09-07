import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @IsNotEmpty()
  filename: string;

  @IsString()
  @IsOptional()
  content_type?: string;

  @IsNumber()
  @IsOptional()
  size_bytes?: number;
}

export class PartUrlDto {
  @IsString()
  @IsNotEmpty()
  upload_id: string;

  @IsInt()
  @Min(1)
  part_number: number;

  @IsInt()
  @Min(1)
  part_size: number;
}

export class PartItemDto {
  @IsInt()
  @Min(1)
  part_number: number;

  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @IsString()
  @IsNotEmpty()
  upload_id: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PartItemDto)
  parts: PartItemDto[];

  @IsNumber()
  @IsOptional()
  size_bytes?: number;
}

export class AbortUploadDto {
  @IsString()
  @IsNotEmpty()
  upload_id: string;
}
