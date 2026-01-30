import {
  AccessDenied,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  BucketNotEmpty,
  InternalError,
  NoSuchBucket,
  NoSuchKey,
} from "../../Services/Backend.ts";
import type { HttpClient } from "@effect/platform";
import type { S3HeaderService } from "../../Services/S3HeaderService.ts";
import type { Checksum } from "../../Services/Checksum.ts";

export interface SwiftTarget {
  readonly client: HttpClient.HttpClient;
  readonly container: string;
  readonly storageUrl: string;
  readonly token: string;
  readonly url: string;
  readonly headerService: S3HeaderService;
  readonly checksumService: Checksum;
}

export const MP_META_PREFIX = ".mp_meta/";
export const MP_SEGMENTS_PREFIX = ".mp_segments/";

/**
 * Encodes an object key for use in Swift URL paths. Decodes each segment first
 * to avoid double-encoding when the key already contains percent-encoded chars
 * (e.g. %2F from the client).
 */
export function encodeObjectKeyForSwift(key: string): string {
  return key.split("/").map((seg) => {
    try {
      return encodeURIComponent(decodeURIComponent(seg));
    } catch {
      return encodeURIComponent(seg);
    }
  }).join("/");
}

export const mapError = (
  status: number,
  message: string,
  bucket: string,
  method?: string,
  key?: string,
) => {
  if (status === 404) {
    if (key) {
      return new NoSuchKey({ bucket, key, message });
    }
    return new NoSuchBucket({ bucket, message });
  }
  if (status === 409) {
    if (message.includes("not empty")) {
      return new BucketNotEmpty({ bucket, message });
    }
    if (message.includes("already exists")) {
      return new BucketAlreadyExists({ bucket, message });
    }
    // For bucket operations (no key), default to BucketAlreadyOwnedByYou
    // For object operations (has key), 409 likely indicates a conflict (e.g., concurrent writes)
    // Use InternalError to avoid misleading bucket ownership error
    if (key) {
      return new InternalError({
        message: `Swift Conflict [409] on ${
          method ?? "UNKNOWN"
        } for object ${key}: ${message}`,
      });
    }
    return new BucketAlreadyOwnedByYou({ bucket, message });
  }
  if (status === 403) {
    return new AccessDenied({ message });
  }
  return new InternalError({
    message: `Swift Error [${status}] on ${method ?? "UNKNOWN"}: ${message}`,
  });
};
