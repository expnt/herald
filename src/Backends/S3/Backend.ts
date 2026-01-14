import { Effect } from "effect"
import {
    ListBucketsCommand,
    CreateBucketCommand,
    DeleteBucketCommand,
    HeadBucketCommand,
    type ListBucketsCommandOutput,
    S3Client as S3ClientSDK
} from "@aws-sdk/client-s3"
import type { MaterializedBucket } from "../../Domain/Config.ts"
import { AppConfig } from "../../Config/Layer.ts"
import {
    type BackendService,
    type BucketInfo,
    NoSuchBucket,
    NoSuchKey,
    BucketAlreadyExists,
    BucketAlreadyOwnedByYou,
    InternalError,
    AccessDenied,
    type BackendError
} from "../../Services/Backend.ts"
import { S3Client } from "./Client.ts"

/**
 * Maps S3 SDK exceptions to internal BackendError types.
 */
function mapS3Error(e: unknown, bucketName?: string): BackendError {
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
            return new NoSuchKey({ bucketName: bucket, key: "unknown", message });
        case "BucketAlreadyExists":
            return new BucketAlreadyExists({ bucketName: bucket, message });
        case "BucketAlreadyOwnedByYou":
            return new BucketAlreadyOwnedByYou({ bucketName: bucket, message });
        case "AccessDenied":
        case "Forbidden":
            return new AccessDenied({ message });
    }

    // Handle case where it might be a raw 404 from HEAD request
    if (err?.$metadata?.httpStatusCode === 404) {
        return new NoSuchKey({ bucketName: bucket, key: "unknown", message: "Not Found" });
    }

    return new InternalError({
        message: e instanceof Error ? e.message : String(e),
    });
}

/**
 * Creates an S3-specific Backend implementation for a given configuration context.
 */
export const makeS3Backend = (
    bucket: MaterializedBucket | { backend_id: string },
): Effect.Effect<BackendService, never, S3Client | AppConfig> =>
    Effect.gen(function* () {
        const s3Service = yield* S3Client;
        const config = yield* AppConfig;

        // Helper to get specialized info from the union type
        const getTargetBucket = () => {
            if ("bucket_name" in bucket) return bucket as MaterializedBucket;

            const backendConfig = config.raw.backends[bucket.backend_id];
            return {
                name: "",
                backend_id: bucket.backend_id,
                protocol: "s3" as const,
                endpoint: backendConfig.endpoint,
                region: backendConfig.region,
                bucket_name: "",
                credentials: backendConfig.credentials,
            };
        };

        const targetBucket = getTargetBucket();

        const service: BackendService = {
            listBuckets: () =>
                Effect.gen(function* () {
                    const client = yield* s3Service.getClient(targetBucket).pipe(
                        Effect.mapError((e) => mapS3Error(e, targetBucket.name))
                    )
                    const result = yield* Effect.tryPromise({
                        try: () => client.send(new ListBucketsCommand({})) as Promise<ListBucketsCommandOutput>,
                        catch: (e) => mapS3Error(e, targetBucket.name),
                    });

                    const buckets: BucketInfo[] = [];
                    for (const b of (result.Buckets ?? [])) {
                        if (b.Name === undefined) {
                            return yield* Effect.fail(
                                new InternalError({ message: "S3 returned bucket without Name" }),
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
                    const client = yield* s3Service.getClient(targetBucket).pipe(
                        Effect.mapError((e) => mapS3Error(e, targetBucket.name))
                    )
                    yield* Effect.tryPromise({
                        try: () =>
                            client.send(
                                new CreateBucketCommand({ Bucket: targetBucket.bucket_name }),
                            ),
                        catch: (e) => mapS3Error(e, targetBucket.bucket_name),
                    });
                }),

            deleteBucket: () =>
                Effect.gen(function* () {
                    const client = yield* s3Service.getClient(targetBucket).pipe(
                        Effect.mapError((e) => mapS3Error(e, targetBucket.name))
                    )
                    yield* Effect.tryPromise({
                        try: () =>
                            client.send(
                                new DeleteBucketCommand({ Bucket: targetBucket.bucket_name }),
                            ),
                        catch: (e) => mapS3Error(e, targetBucket.bucket_name),
                    });
                }),

            headBucket: () =>
                Effect.gen(function* () {
                    const client = yield* s3Service.getClient(targetBucket).pipe(
                        Effect.mapError((e) => mapS3Error(e, targetBucket.name))
                    )
                    yield* Effect.tryPromise({
                        try: () =>
                            client.send(
                                new HeadBucketCommand({ Bucket: targetBucket.bucket_name }),
                            ),
                        catch: (e) => mapS3Error(e, targetBucket.bucket_name),
                    });
                }),

            proxy: (request) =>
                s3Service.proxy(targetBucket, request).pipe(
                    Effect.catchAll((e) =>
                        Effect.fail(mapS3Error(e, targetBucket.bucket_name))
                    ),
                ),
        };

        return service;
    });
