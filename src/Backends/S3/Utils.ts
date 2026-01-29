import {
  AccessDenied,
  BadDigest,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  BucketNotEmpty,
  EntityTooSmall,
  InternalError,
  InvalidArgument,
  InvalidPart,
  InvalidPartOrder,
  InvalidRequest,
  MalformedXML,
  NoSuchBucket,
  NoSuchKey,
  NoSuchUpload,
} from "../../Services/Backend.ts";
import type { S3Client } from "@aws-sdk/client-s3";
import type { S3HeaderService } from "../../Services/S3HeaderService.ts";
import type { Checksum } from "../../Services/Checksum.ts";

export interface S3Target {
  readonly client: S3Client;
  readonly bucketName: string;
  readonly name: string;
  readonly headerService: S3HeaderService;
  readonly checksumService: Checksum;
}

export const mapS3Error = (
  e: unknown,
  bucket: string,
  uploadId?: string,
) => {
  if (e instanceof BadDigest) return e;

  const error = e as {
    name?: string;
    Code?: string;
    message?: string;
    Message?: string;
    Key?: string;
    cause?: unknown;
  };

  // Check for BadDigest in the error message or cause
  const errorStr = String(e);
  if (
    errorStr.includes("BadDigest") || errorStr.includes("checksum mismatch") ||
    errorStr.includes("Checksum mismatch")
  ) {
    return new BadDigest({ message: errorStr });
  }
  if (error.cause) {
    if (error.cause instanceof BadDigest) return error.cause;
    const causeStr = String(error.cause);
    if (
      causeStr.includes("BadDigest") ||
      causeStr.includes("checksum mismatch") ||
      causeStr.includes("Checksum mismatch")
    ) {
      return new BadDigest({ message: causeStr });
    }
  }

  const name = error.name || error.Code || "InternalError";
  const message = error.message || error.Message || "Internal S3 Error";

  switch (name) {
    case "NoSuchBucket":
    case "NotFound": // S3 sometimes returns NotFound for HEAD requests on non-existent buckets
      return new NoSuchBucket({ bucket, message });
    case "NoSuchKey":
      return new NoSuchKey({
        bucket,
        key: error.Key || "unknown",
        message,
      });
    case "AccessDenied":
      return new AccessDenied({ message });
    case "BucketAlreadyExists":
      return new BucketAlreadyExists({ bucket, message });
    case "BucketAlreadyOwnedByYou":
      return new BucketAlreadyOwnedByYou({ bucket, message });
    case "BucketNotEmpty":
      return new BucketNotEmpty({ bucket, message });
    case "InvalidBucketName":
      return new InternalError({ message: `Invalid bucket name: ${bucket}` });
    case "InvalidArgument":
      return new InvalidArgument({ message });
    case "NoSuchUpload":
      return new NoSuchUpload({
        uploadId: uploadId || "unknown",
        message,
      });
    case "InvalidRequest":
      return new InvalidRequest({ message });
    case "MalformedXML":
      return new MalformedXML({ message });
    case "InvalidPart":
      return new InvalidPart({ message });
    case "InvalidPartOrder":
      return new InvalidPartOrder({ message });
    case "EntityTooSmall":
      return new EntityTooSmall({ message });
    default:
      return new InternalError({
        message: `S3 Error [${name}]: ${message}`,
      });
  }
};

/**
 * Minio sometimes adds metadata prefixes like 'X-Amz-Meta-' to keys in listings.
 * This helper strips them if present.
 */
export const stripMinioMetadata = (key: string): string => {
  // if (key.startsWith("X-Amz-Meta-")) {
  //   return key.substring("X-Amz-Meta-".length);
  // }
  return key;
};
