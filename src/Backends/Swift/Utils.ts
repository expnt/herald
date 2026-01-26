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

import type { HttpClient } from "@effect/platform";
import type { S3HeaderService } from "../../Services/S3HeaderService.ts";
import type { Checksum } from "../../Services/Checksum.ts";

export const INTERNAL_PREFIX = ".hrld/";
export const MP_META_PREFIX = `${INTERNAL_PREFIX}mmp/`;
export const MP_SEGMENTS_PREFIX = `${INTERNAL_PREFIX}msg/`;

export interface SwiftTarget {
  readonly storageUrl: string;
  readonly token: string;
  readonly container: string;
  readonly url: string;
  readonly client: HttpClient.HttpClient;
  readonly headerService: S3HeaderService;
  readonly checksumService: Checksum;
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
