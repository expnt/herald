import { Effect } from "effect";
import {
  type BackendError,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  BucketNotEmpty,
  InternalError,
  InvalidBucketName,
  InvalidRequest,
  NoSuchBucket,
  NoSuchKey,
} from "../../Services/Backend.ts";
import type { MaterializedBucket } from "../../Domain/Config.ts";
import { SwiftClient } from "./Client.ts";

import type { KeyValueStore } from "@effect/platform";

export interface SwiftBaseTarget {
  readonly storageUrl: string;
  readonly token: string;
  readonly container: string;
  readonly url: string;
}

export interface SwiftTarget extends SwiftBaseTarget {
  readonly multipartMetadataStore: KeyValueStore.KeyValueStore;
}

export const INTERNAL_PREFIX = ".hrld/";
export const MP_META_PREFIX = `${INTERNAL_PREFIX}mmp/`;
export const MP_SEGMENTS_PREFIX = `${INTERNAL_PREFIX}msg/`;

/**
 * Safely extracts a header value from a record that might contain arrays.
 */
export function extractHeader(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const val = headers[key] || headers[key.toLowerCase()];
  return Array.isArray(val) ? val[0] : val;
}

export const mapError = (
  status: number,
  message: string,
  bucketName: string,
  method?: string,
  key?: string,
): BackendError => {
  switch (status) {
    case 404:
      if (key) {
        return new NoSuchKey({ bucketName, key, message });
      }
      return new NoSuchBucket({ bucketName, message });
    case 409:
      if (method === "DELETE") {
        return new BucketNotEmpty({ bucketName, message });
      }
      if (method === "PUT" && !key) {
        return new BucketAlreadyExists({ bucketName, message });
      }
      return new InternalError({
        message: `Swift conflict error (${status}): ${message}`,
      });
    case 202:
      if (method === "PUT") {
        return new BucketAlreadyOwnedByYou({ bucketName, message });
      }
      return new InternalError({
        message: `Swift error (${status}): ${message}`,
      });
    case 400:
      if (message.includes("Invalid bucket name")) {
        return new InvalidBucketName({ message });
      }
      return new InvalidRequest({ message });
    default:
      return new InternalError({
        message: `Swift error (${status}): ${message}`,
      });
  }
};

/**
 * Resolves the target container and acquires the Swift token dynamically.
 */
export const getTarget = (
  bucket: MaterializedBucket | { backend_id: string },
): Effect.Effect<SwiftBaseTarget, BackendError, SwiftClient> =>
  Effect.gen(function* () {
    const swiftClient = yield* SwiftClient;
    const auth = yield* swiftClient.getAuthMeta(bucket).pipe(
      Effect.mapError((e) => new InternalError({ message: e.message })),
    );
    const container = "bucket_name" in bucket ? bucket.bucket_name : "";
    const encodedContainer = container ? encodeURIComponent(container) : "";
    const res = {
      storageUrl: auth.storageUrl,
      token: auth.token,
      container,
      url: encodedContainer
        ? `${auth.storageUrl}/${encodedContainer}`
        : auth.storageUrl,
    };
    yield* Effect.logDebug(
      `SwiftTarget resolved: url=[${res.url}] container=[${res.container}]`,
    );
    return res;
  });
