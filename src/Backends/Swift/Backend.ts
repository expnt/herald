import { Effect } from "effect";
import { HttpClient } from "@effect/platform";
import type {
  BackendError,
  BackendService,
  ListObjectsResult,
  ObjectResponse,
  PutObjectResult,
} from "../../Services/Backend.ts";
import type { MaterializedBucket } from "../../Domain/Config.ts";
import { makeBucketOps } from "./Buckets.ts";
import { makeObjectOps } from "./Objects.ts";
import { getTarget, MP_META_PREFIX } from "./Utils.ts";
import type { SwiftClient } from "./Client.ts";
import { makeBackendKeyValueStore } from "../../Services/BackendKeyValueStore.ts";
import type { Stream } from "effect";
import type { Checksum } from "../../Services/Checksum.ts";
import type { S3HeaderService } from "../../Services/S3HeaderService.ts";

/**
 * Creates a Swift-specific Backend implementation for a given configuration context.
 * Composes bucket and object operations modularly.
 * Resolves the target and client once per backend creation (request-scoped).
 */
export const makeSwiftBackend = (
  bucket: MaterializedBucket | { backend_id: string },
): Effect.Effect<
  BackendService,
  BackendError,
  SwiftClient | HttpClient.HttpClient | Checksum | S3HeaderService
> =>
  Effect.gen(function* () {
    const target = yield* getTarget(bucket);
    const client = yield* HttpClient.HttpClient;

    // Create a temporary objectOps to satisfy the store's requirement
    // But we need the real one for the backend.
    // In Swift, the store just uses listObjects/getObject/putObject/deleteObject.

    // deno-lint-ignore prefer-const
    let objectOps: ReturnType<typeof makeObjectOps>;
    const multipartMetadataStore = makeBackendKeyValueStore(
      {
        listObjects: (args: {
          prefix?: string;
          delimiter?: string;
          marker?: string;
          maxKeys?: number;
          encodingType?: string;
          continuationToken?: string;
          startAfter?: string;
          listType?: 1 | 2;
        }): Effect.Effect<ListObjectsResult, BackendError> =>
          objectOps.listObjects(args),
        getObject: (
          key: string,
          headers: Record<string, string | string[] | undefined>,
        ): Effect.Effect<ObjectResponse, BackendError, S3HeaderService> =>
          objectOps.getObject(key, headers),
        putObject: (
          key: string,
          stream: Stream.Stream<Uint8Array, Error>,
          headers: Record<string, string | string[] | undefined>,
        ): Effect.Effect<
          PutObjectResult,
          BackendError,
          Checksum | S3HeaderService
        > => objectOps.putObject(key, stream, headers),
        deleteObject: (key: string): Effect.Effect<void, BackendError> =>
          objectOps.deleteObject(key),
      } as unknown as BackendService,
      MP_META_PREFIX,
    );

    const fullTarget = { ...target, multipartMetadataStore };
    const objectOpsReal = makeObjectOps(fullTarget, client);
    objectOps = objectOpsReal;
    const bucketOps = makeBucketOps(fullTarget, client, objectOpsReal);

    const backend: BackendService = {
      ...bucketOps,
      ...objectOpsReal,
      multipartMetadataStore,
    } as unknown as BackendService;

    return backend;
  });
