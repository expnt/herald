import { Effect } from "effect";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  type ListBucketsCommandOutput,
} from "@aws-sdk/client-s3";
import { type BucketInfo, InternalError } from "../../Services/Backend.ts";
import { mapS3Error, type S3Target } from "./Utils.ts";

export const makeBucketOps = (target: S3Target) => ({
  listBuckets: () =>
    Effect.gen(function* () {
      const { client, name } = target;
      const result = yield* Effect.tryPromise({
        try: () =>
          client.send(new ListBucketsCommand({})) as Promise<
            ListBucketsCommandOutput
          >,
        catch: (e) => mapS3Error(e, name),
      });

      const buckets: BucketInfo[] = [];
      for (const b of (result.Buckets ?? [])) {
        if (b.Name === undefined) {
          return yield* Effect.fail(
            new InternalError({
              message: "S3 returned bucket without Name",
            }),
          );
        }
        buckets.push({
          name: b.Name,
          creationDate: b.CreationDate,
        });
      }

      return {
        buckets,
        owner: {
          id: result.Owner?.ID ?? "unknown-owner-id",
          displayName: result.Owner?.DisplayName ?? "unknown-owner-name",
        },
      };
    }),

  createBucket: () =>
    Effect.gen(function* () {
      const { client, bucketName, name } = target;
      yield* Effect.tryPromise({
        try: () => client.send(new CreateBucketCommand({ Bucket: bucketName })),
        catch: (e) => mapS3Error(e, bucketName || name),
      });
    }),

  deleteBucket: () =>
    Effect.gen(function* () {
      const { client, bucketName, name } = target;
      yield* Effect.tryPromise({
        try: () => client.send(new DeleteBucketCommand({ Bucket: bucketName })),
        catch: (e) => mapS3Error(e, bucketName || name),
      });
    }),

  headBucket: () =>
    Effect.gen(function* () {
      const { client, bucketName, name } = target;
      yield* Effect.tryPromise({
        try: () => client.send(new HeadBucketCommand({ Bucket: bucketName })),
        catch: (e) => mapS3Error(e, bucketName || name),
      });
    }),
});
