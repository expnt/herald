import type { S3Client as S3ClientSDK } from "@aws-sdk/client-s3";
import {
  AccessDenied,
  type BackendError,
  BadDigest,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  BucketNotEmpty,
  EntityTooSmall,
  InternalError,
  InvalidArgument,
  InvalidBucketName,
  InvalidPart,
  InvalidPartOrder,
  InvalidRequest,
  MalformedXML,
  NoSuchBucket,
  NoSuchKey,
  NoSuchUpload,
} from "../../Services/Backend.ts";

import type { KeyValueStore } from "@effect/platform";
import type { S3HeaderService } from "../../Services/S3HeaderService.ts";
import type { Checksum } from "../../Services/Checksum.ts";

export interface S3Target {
  readonly client: S3ClientSDK;
  readonly bucketName: string;
  readonly name: string;
  readonly multipartMetadataStore: KeyValueStore.KeyValueStore;
  readonly headerService: S3HeaderService;
  readonly checksumService: Checksum;
}

/**
 * Strips MinIO metadata suffixes like [minio_cache:v2,return:] from strings.
 */
export function stripMinioMetadata(s: string): string {
  return s.replace(/\[minio_cache:[^\]]+\]/g, "");
}

/**
 * Maps S3 SDK exceptions to internal BackendError types.
 */
export function mapS3Error(e: unknown, bucketName?: string): BackendError {
  const err = e as {
    name?: string;
    Code?: string;
    Message?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const name = err?.name || err?.Code ||
    (e instanceof Error ? e.name : "UnknownError");
  const message = err?.message || err?.Message ||
    "An unknown S3 error occurred";
  const bucket = bucketName ?? "unknown-bucket";

  switch (name) {
    case "NoSuchBucket":
    case "NotFound":
      return new NoSuchBucket({ bucketName: bucket, message });
    case "NoSuchKey":
      return new NoSuchKey({
        bucketName: bucket,
        key: "unknown",
        message: message,
      });
    case "NoSuchUpload":
      return new NoSuchUpload({
        uploadId: "unknown",
        message: message,
      });
    case "InvalidPart":
    case "InvalidPartNumber":
      return new InvalidPart({ message });
    case "InvalidPartOrder":
      return new InvalidPartOrder({ message });
    case "EntityTooSmall":
      return new EntityTooSmall({ message });
    case "InvalidRequest":
      if (message.includes("at least one part")) {
        return new MalformedXML({ message });
      }
      return new InvalidRequest({ message });
    case "MalformedXML":
      return new MalformedXML({ message });
    case "BucketAlreadyExists":
      return new BucketAlreadyExists({ bucketName: bucket, message });
    case "BucketAlreadyOwnedByYou":
      return new BucketAlreadyOwnedByYou({ bucketName: bucket, message });
    case "AccessDenied":
    case "Forbidden":
      return new AccessDenied({ message });
    case "BucketNotEmpty":
    case "Conflict":
      return new BucketNotEmpty({ bucketName: bucket, message });
    case "InvalidArgument":
      return new InvalidArgument({ message });
    case "BadDigest":
      return new BadDigest({ message });
    case "InvalidAttributeName":
      return new InvalidArgument({
        message: "Invalid attribute name specified.",
      });
    case "InvalidBucketName":
      return new InvalidBucketName({ message });
  }

  // Handle case where it might be a raw 404 from HEAD request
  if (err?.$metadata?.httpStatusCode === 404) {
    return new NoSuchKey({
      bucketName: bucket,
      key: "unknown",
      message: "Not Found",
    });
  }

  if (err?.$metadata?.httpStatusCode === 400) {
    return new InvalidRequest({ message });
  }

  return new InternalError({
    message: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
  });
}
