import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { RESERVED_INTERNAL_PREFIXES } from "../../Services/InternalNamespace.ts";
import { Effect } from "effect";
import type {
  AccessControlPolicy,
  BucketInfo,
  CannedAcl,
  ListBucketsResult,
  OwnerInfo,
} from "../../Services/Backend.ts";
import {
  defaultPolicy,
  parseGrantHeaders,
  resolveAclInput,
} from "../../Services/Acl.ts";
import { mapS3Error, type S3Target } from "./Utils.ts";
import {
  ACL_BUCKET_KEY,
  makeOwnerResolver,
  readStoredPolicy,
  writeStoredPolicy,
} from "./AclStore.ts";

export const makeBucketOps = ({
  client,
  bucketName: _bucketName,
}: S3Target) => {
  const getOwner = makeOwnerResolver(client);

  return {
    listBuckets: () =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () => client.send(new ListBucketsCommand({})),
          catch: (e) => mapS3Error(e, "*"),
        });

        return {
          buckets: (result.Buckets ?? []).map(
            (b): BucketInfo => ({
              name: b.Name ?? "",
              creationDate: b.CreationDate ?? new Date(),
            }),
          ),
          owner: {
            id: result.Owner?.ID ?? "unknown",
            displayName: result.Owner?.DisplayName ?? "unknown",
          },
        } satisfies ListBucketsResult;
      }),

    createBucket: (
      name: string,
      headers: Record<string, string | string[] | undefined>,
    ) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () =>
            client.send(
              new CreateBucketCommand({
                Bucket: name,
              }),
            ),
          catch: (e) => mapS3Error(e, name),
        });

        // Persist a canned ACL supplied at creation time (x-amz-acl header)
        // and/or explicit x-amz-grant-* headers.
        const canned = headerValue(headers, "x-amz-acl");
        const grantHeaders = parseGrantHeaders(headers);
        if (canned || grantHeaders) {
          const owner = yield* getOwner();
          // S3 semantics: x-amz-grant-* headers fully define the ACL when no
          // canned header is present — they replace the ACL instead of
          // merging into the default owner-FULL_CONTROL policy.
          const policy = canned
            ? resolveAclInput(canned as CannedAcl, owner)
            : { owner, grants: grantHeaders ?? [] };
          const resolved = grantHeaders && canned
            ? { ...policy, grants: [...policy.grants, ...grantHeaders] }
            : policy;
          yield* writeStoredPolicy(client, name, ACL_BUCKET_KEY, resolved);
        }
      }),

    deleteBucket: (name: string) =>
      Effect.gen(function* () {
        // Purge Herald's internal state (reserved .hrld/** prefixes and
        // legacy ones) before deleting the bucket. Backends reject
        // DeleteBucket on non-empty buckets, and these hidden objects are
        // filtered from client-facing listings, so clients can never clean
        // them up themselves. ListObjectVersions is required: plain
        // ListObjectsV2 cannot see versions or delete markers of internal
        // keys (e.g. an ACL entry written under a delete-marked object),
        // which would otherwise strand the bucket forever.
        for (const prefix of RESERVED_INTERNAL_PREFIXES) {
          let keyMarker: string | undefined = undefined;
          let versionIdMarker: string | undefined = undefined;
          while (true) {
            const listResult = yield* Effect.tryPromise({
              try: () =>
                client.send(
                  new ListObjectVersionsCommand({
                    Bucket: name,
                    Prefix: prefix,
                    KeyMarker: keyMarker,
                    VersionIdMarker: versionIdMarker,
                  }),
                ),
              catch: (e) => mapS3Error(e, name),
            });
            const entries = [
              ...(listResult.Versions ?? []).map((v) => ({
                Key: v.Key!,
                VersionId: v.VersionId,
              })),
              ...(listResult.DeleteMarkers ?? []).map((m) => ({
                Key: m.Key!,
                VersionId: m.VersionId,
              })),
            ];
            if (entries.length > 0) {
              yield* Effect.tryPromise({
                try: () =>
                  client.send(
                    new DeleteObjectsCommand({
                      Bucket: name,
                      Delete: { Objects: entries, Quiet: true },
                    }),
                  ),
                catch: (e) => mapS3Error(e, name),
              }).pipe(Effect.ignore);
            }
            if (!listResult.IsTruncated || !listResult.NextKeyMarker) {
              break;
            }
            keyMarker = listResult.NextKeyMarker;
            versionIdMarker = listResult.NextVersionIdMarker;
          }
        }

        yield* Effect.tryPromise({
          try: () =>
            client.send(
              new DeleteBucketCommand({
                Bucket: name,
              }),
            ),
          catch: (e) => mapS3Error(e, name),
        });
      }),

    headBucket: (name: string) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () =>
            client.send(
              new HeadBucketCommand({
                Bucket: name,
              }),
            ),
          catch: (e) => mapS3Error(e, name),
        });
      }),

    putBucketVersioning: (name: string, status: "Enabled" | "Suspended") =>
      Effect.gen(function* () {
        // MinIO accepts PutBucketVersioning for nonexistent buckets (real S3
        // answers NoSuchBucket), so verify existence explicitly first.
        yield* Effect.tryPromise({
          try: () => client.send(new HeadBucketCommand({ Bucket: name })),
          catch: (e) => mapS3Error(e, name),
        });
        yield* Effect.tryPromise({
          try: () =>
            client.send(
              new PutBucketVersioningCommand({
                Bucket: name,
                VersioningConfiguration: { Status: status },
              }),
            ),
          catch: (e) => mapS3Error(e, name),
        });
      }),

    getBucketVersioning: (name: string) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () =>
            client.send(
              new GetBucketVersioningCommand({
                Bucket: name,
              }),
            ),
          catch: (e) => mapS3Error(e, name),
        });
        return { status: result.Status };
      }),

    getBucketAcl: (name: string) =>
      Effect.gen(function* () {
        const owner = yield* getOwner();
        const stored = yield* readStoredPolicy(client, name, ACL_BUCKET_KEY);
        return stored ?? defaultPolicy(owner);
      }),

    putBucketAcl: (
      name: string,
      acl: AccessControlPolicy | CannedAcl,
      ownerOverride?: OwnerInfo,
    ) =>
      Effect.gen(function* () {
        const owner = ownerOverride ?? (yield* getOwner());
        yield* writeStoredPolicy(
          client,
          name,
          ACL_BUCKET_KEY,
          resolveAclInput(acl, owner),
        );
      }),
  };
};

const headerValue = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  if (!entry) return undefined;
  const value = entry[1];
  return Array.isArray(value) ? value[0] : value;
};
