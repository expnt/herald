import {
  GetObjectCommand,
  ListBucketsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Effect } from "effect";
import type {
  AccessControlPolicy,
  BackendError,
  OwnerInfo,
} from "../../Services/Backend.ts";
import { NoSuchKey } from "../../Services/Backend.ts";
import { mapS3Error } from "./Utils.ts";

/**
 * Internal object keys used to persist ACL state. MinIO's native ACL support
 * is a stub (PutObjectAcl is NotImplemented, GetBucketAcl returns an empty
 * owner), so Herald records the canonical policy as a hidden object in the
 * bucket, filtered from listings by the reserved internal prefix.
 */
export const ACL_BUCKET_KEY = ".hrld/acl/bucket";
export const aclObjectKey = (key: string) =>
  `.hrld/acl/object/${encodeURIComponent(key)}`;

export const readStoredPolicy = (
  client: import("@aws-sdk/client-s3").S3Client,
  bucket: string,
  key: string,
): Effect.Effect<AccessControlPolicy | undefined, BackendError> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        ),
      catch: (e) => mapS3Error(e, bucket),
    });
    const body = yield* Effect.tryPromise({
      try: async () => {
        const stream = result.Body;
        return stream ? await stream.transformToString() : "";
      },
      catch: (e) => mapS3Error(e, bucket),
    });
    if (body === "") return undefined;
    return JSON.parse(body) as AccessControlPolicy;
  }).pipe(
    Effect.catchIf(
      (e) => e instanceof NoSuchKey,
      () => Effect.succeed(undefined),
    ),
  );

export const writeStoredPolicy = (
  client: import("@aws-sdk/client-s3").S3Client,
  bucket: string,
  key: string,
  policy: AccessControlPolicy,
): Effect.Effect<void, BackendError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: JSON.stringify(policy),
          }),
        ),
      catch: (e) => mapS3Error(e, bucket),
    });
  });

/**
 * Resolves the canonical owner for the S3 backend from ListBuckets, cached
 * per backend instance. MinIO's ACL responses return an empty owner, so the
 * proxy synthesizes the owner from the account that owns the buckets.
 */
export const makeOwnerResolver = (
  client: import("@aws-sdk/client-s3").S3Client,
) => {
  let cachedOwner: OwnerInfo | undefined;
  return (): Effect.Effect<OwnerInfo, BackendError> =>
    Effect.gen(function* () {
      if (cachedOwner) return cachedOwner;
      const result = yield* Effect.tryPromise({
        try: () => client.send(new ListBucketsCommand({})),
        catch: (e) => mapS3Error(e, "*"),
      });
      cachedOwner = {
        id: result.Owner?.ID ?? "unknown",
        displayName: result.Owner?.DisplayName ?? "unknown",
      };
      return cachedOwner;
    });
};
