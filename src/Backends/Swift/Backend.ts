import { HttpClient } from "@effect/platform";
import type { Stream } from "effect";
import { Effect } from "effect";
import type { MaterializedBucket } from "../../Domain/Config.ts";
import { Backend, InternalError } from "../../Services/Backend.ts";
import { makeBackendKeyValueStore } from "../../Services/BackendKeyValueStore.ts";
import { Checksum } from "../../Services/Checksum.ts";
import { S3HeaderService } from "../../Services/S3HeaderService.ts";
import { makeBucketOps } from "./Buckets.ts";
import { SwiftClient } from "./Client.ts";
import { makeObjectOps } from "./Objects.ts";
import { MP_META_PREFIX } from "./Utils.ts";

/**
 * Creates a Swift-specific Backend implementation for a given configuration context.
 * Composes bucket and object operations modularly.
 * Resolves the target and client once per backend creation (request-scoped).
 */
export const makeSwiftBackend = (
  bucket: MaterializedBucket | { backend_id: string },
) =>
  Effect.gen(function* () {
    const swiftClient = yield* SwiftClient;
    const client = yield* HttpClient.HttpClient;
    const headerService = yield* S3HeaderService;
    const checksumService = yield* Checksum;
    const auth = yield* swiftClient.getAuthMeta(bucket).pipe(
      Effect.mapError((e) => new InternalError({ message: e.message })),
    );
    const container = "bucket_name" in bucket ? bucket.bucket_name : "";
    const encodedContainer = container ? encodeURIComponent(container) : "";
    const target = {
      storageUrl: auth.storageUrl,
      token: auth.token,
      container,
      url: encodedContainer
        ? `${auth.storageUrl}/${encodedContainer}`
        : auth.storageUrl,
      client,
      headerService,
      checksumService,
    };
    yield* Effect.logDebug(
      `SwiftTarget resolved: url=[${target.url}] container=[${target.container}]`,
    );

    // Create a temporary objectOps to satisfy the store's requirement
    // But we need the real one for the backend.
    // In Swift, the store just uses listObjects/getObject/putObject/deleteObject.

    // deno-lint-ignore prefer-const
    let objectOps: ReturnType<typeof makeObjectOps>;
    const multipartMetadataStore = makeBackendKeyValueStore(
      {
        getObject: (
          key: string,
          headers: Record<string, string | string[] | undefined>,
        ) => objectOps.getObject(key, headers),
        putObject: (
          key: string,
          stream: Stream.Stream<Uint8Array, Error>,
          headers: Record<string, string | string[] | undefined>,
        ) => objectOps.putObject(key, stream, headers),
        deleteObject: (key: string) => objectOps.deleteObject(key),
      },
      MP_META_PREFIX,
    );

    const objectOpsReal = makeObjectOps(target);
    objectOps = objectOpsReal;
    const bucketOps = makeBucketOps(target, objectOpsReal);

    return Backend.of({
      ...bucketOps,
      ...objectOpsReal,
      multipartMetadataStore,
    });
  });
