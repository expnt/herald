import { Effect } from "effect";
import type { S3Client as S3ClientSDK } from "@aws-sdk/client-s3";
import type { MaterializedBucket } from "../../Domain/Config.ts";
import { HeraldConfig } from "../../Config/Layer.ts";
import {
  AccessDenied,
  type BackendError,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  BucketNotEmpty,
  EntityTooSmall,
  InternalError,
  InvalidPart,
  InvalidPartOrder,
  InvalidRequest,
  MalformedXML,
  NoSuchBucket,
  NoSuchKey,
  NoSuchUpload,
} from "../../Services/Backend.ts";
import { S3Client } from "./Client.ts";

export interface S3Target {
  readonly client: S3ClientSDK;
  readonly bucketName: string;
  readonly name: string;
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
  }

  // Handle case where it might be a raw 404 from HEAD request
  if (err?.$metadata?.httpStatusCode === 404) {
    return new NoSuchKey({
      bucketName: bucket,
      key: "unknown",
      message: "Not Found",
    });
  }

  return new InternalError({
    message: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
  });
}

/**
 * Resolves the target bucket configuration and acquires the S3 client.
 * This ensures the backend remains a stateless proxy that picks up request-local configuration and clients.
 */
export const getTarget = (
  bucket: MaterializedBucket | { backend_id: string },
): Effect.Effect<S3Target, BackendError, S3Client | HeraldConfig> =>
  Effect.gen(function* () {
    const s3Service = yield* S3Client;
    const config = yield* HeraldConfig;

    const resolveTargetBucket = (): MaterializedBucket => {
      if ("bucket_name" in bucket) return bucket as MaterializedBucket;

      const backendConfig = config.raw.backends[bucket.backend_id];
      if (backendConfig && backendConfig.protocol === "s3") {
        return {
          name: "",
          backend_id: bucket.backend_id,
          protocol: "s3" as const,
          endpoint: backendConfig.endpoint,
          region: backendConfig.region,
          bucket_name: "",
          credentials: backendConfig.credentials,
        };
      }
      throw new Error(`Backend ${bucket.backend_id} is not an S3 backend`);
    };

    const targetBucket = resolveTargetBucket();
    const client = yield* s3Service.getClient(targetBucket).pipe(
      Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
    );

    return {
      client,
      bucketName: targetBucket.bucket_name,
      name: targetBucket.name,
    };
  });
