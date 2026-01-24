import { Effect } from "effect";
import type { MaterializedBucket } from "../../Domain/Config.ts";
import type { BackendError, BackendService } from "../../Services/Backend.ts";
import { makeBucketOps } from "./Buckets.ts";
import { makeObjectOps } from "./Objects.ts";
import { getTarget } from "./Utils.ts";
import type { S3Client } from "./Client.ts";
import type { HeraldConfig } from "../../Config/Layer.ts";
import { makeNoopKeyValueStore } from "../../Services/NoopKeyValueStore.ts";
import type { Checksum } from "../../Services/Checksum.ts";
import type { S3HeaderService } from "../../Services/S3HeaderService.ts";

/**
 * Creates an S3-specific Backend implementation for a given configuration context.
 * Composes bucket and object operations modularly.
 * Resolves the target once per backend creation (request-scoped).
 */
export const makeS3Backend = (
  bucket: MaterializedBucket | { backend_id: string },
): Effect.Effect<
  BackendService,
  BackendError,
  S3Client | HeraldConfig | Checksum | S3HeaderService
> =>
  Effect.gen(function* () {
    const target = yield* getTarget(bucket);
    const multipartMetadataStore = makeNoopKeyValueStore();
    const fullTarget = { ...target, multipartMetadataStore };
    return ({
      ...makeBucketOps(fullTarget),
      ...makeObjectOps(fullTarget),
      multipartMetadataStore,
    } as unknown) as BackendService;
  });
