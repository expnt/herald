import { Effect } from "effect";
import { HeraldConfig } from "../../Config/Layer.ts";
import type { MaterializedBucket } from "../../Domain/Config.ts";
import { Backend } from "../../Services/Backend.ts";
import { makeNoopKeyValueStore } from "../../Services/NoopKeyValueStore.ts";
import { makeBucketOps } from "./Buckets.ts";
import { S3ClientFactory } from "./Client.ts";
import { makeObjectOps } from "./Objects.ts";
import { makeMultipartOps } from "./Multipart.ts";
import { mapS3Error } from "./Utils.ts";
import { S3HeaderService } from "../../Services/S3HeaderService.ts";
import { Checksum } from "../../Services/Checksum.ts";

/**
 * Creates an S3-specific Backend implementation for a given configuration context.
 * Composes bucket and object operations modularly.
 * Resolves the target once per backend creation (request-scoped).
 */
export const makeS3Backend = (
  bucket: MaterializedBucket | { backend_id: string },
) =>
  Effect.gen(function* () {
    const clientFactory = yield* S3ClientFactory;
    const config = yield* HeraldConfig;
    const headerService = yield* S3HeaderService;
    const checksumService = yield* Checksum;

    const resolveTargetBucket = (): MaterializedBucket => {
      if ("bucket_name" in bucket) return bucket as MaterializedBucket;

      const backendConfig = config.raw.backends[bucket.backend_id];
      if (backendConfig && backendConfig.protocol === "s3") {
        return {
          name: "",
          backend_id: bucket.backend_id,
          protocol: "s3" as const,
          endpoint: backendConfig.endpoint,
          region: backendConfig.region,
          bucket_name: "",
          credentials: backendConfig.credentials,
        };
      }
      throw new Error(`Backend ${bucket.backend_id} is not an S3 backend`);
    };

    const targetBucket = resolveTargetBucket();
    const client = yield* clientFactory.getClient(targetBucket).pipe(
      Effect.mapError((e) => mapS3Error(e, targetBucket.name)),
    );

    const multipartMetadataStore = makeNoopKeyValueStore();
    const target = {
      client,
      bucketName: targetBucket.bucket_name,
      name: targetBucket.name,
      headerService,
      multipartMetadataStore,
      checksumService,
    };
    return Backend.of({
      ...makeBucketOps(target),
      ...makeObjectOps(target),
      ...makeMultipartOps(target),
    });
  });
