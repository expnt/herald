import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { Effect } from "effect";
import type {
  AccessControlPolicy,
  BucketInfo,
  CannedAcl,
  ListBucketsResult,
} from "../../Services/Backend.ts";
import { defaultPolicy, resolveAclInput } from "../../Services/Acl.ts";
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

        // Persist a canned ACL supplied at creation time (x-amz-acl header).
        const canned = headerValue(headers, "x-amz-acl");
        if (canned) {
          const owner = yield* getOwner();
          yield* writeStoredPolicy(
            client,
            name,
            ACL_BUCKET_KEY,
            resolveAclInput(canned as CannedAcl, owner),
          );
        }
      }),

    deleteBucket: (name: string) =>
      Effect.gen(function* () {
        // Remove persisted ACL state (hidden .hrld/acl/ objects) so the
        // bucket can be deleted; MinIO rejects DeleteBucket on non-empty
        // buckets.
        let continuationToken: string | undefined;
        while (true) {
          const listResult = yield* Effect.tryPromise({
            try: () =>
              client.send(
                new ListObjectsV2Command({
                  Bucket: name,
                  Prefix: ".hrld/acl/",
                  ContinuationToken: continuationToken,
                }),
              ),
            catch: (e) => mapS3Error(e, name),
          });
          for (const obj of listResult.Contents ?? []) {
            if (obj.Key) {
              yield* Effect.tryPromise({
                try: () =>
                  client.send(
                    new DeleteObjectCommand({ Bucket: name, Key: obj.Key }),
                  ),
                catch: (e) => mapS3Error(e, name),
              }).pipe(Effect.ignore);
            }
          }
          if (!listResult.IsTruncated || !listResult.NextContinuationToken) {
            break;
          }
          continuationToken = listResult.NextContinuationToken;
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

    putBucketAcl: (name: string, acl: AccessControlPolicy | CannedAcl) =>
      Effect.gen(function* () {
        const owner = yield* getOwner();
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
