import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
} from "@aws-sdk/client-s3";
import { Effect } from "effect";
import type { BucketInfo, ListBucketsResult } from "../../Services/Backend.ts";
import { mapS3Error, type S3Target } from "./Utils.ts";

export const makeBucketOps = (
  { client, bucketName }: S3Target,
) => ({
  listBuckets: () =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () => client.send(new ListBucketsCommand({})),
        catch: (e) => mapS3Error(e, bucketName),
      });

      return {
        buckets: (result.Buckets ?? []).map((b): BucketInfo => ({
          name: b.Name ?? "",
          creationDate: b.CreationDate ?? new Date(),
        })),
        owner: {
          id: result.Owner?.ID ?? "unknown",
          displayName: result.Owner?.DisplayName ?? "unknown",
        },
      } satisfies ListBucketsResult;
    }),

  createBucket: (
    name: string,
    _headers: Record<string, string | string[] | undefined>,
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
    }),

  deleteBucket: (name: string) =>
    Effect.gen(function* () {
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
});
