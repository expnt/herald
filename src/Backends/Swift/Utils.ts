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
    return new BucketAlreadyOwnedByYou({ bucket, message });
  }
  if (status === 403) {
    return new AccessDenied({ message });
  }
  return new InternalError({
    message: `Swift Error [${status}] on ${method ?? "UNKNOWN"}: ${message}`,
  });
};
