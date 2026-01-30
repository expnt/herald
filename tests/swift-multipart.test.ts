import { Cause, Effect, Exit, Option } from "effect";
import { FetchHttpClient, HttpClient, KeyValueStore } from "@effect/platform";
import { makeMultipartOps } from "../src/Backends/Swift/Multipart.ts";
import {
  MP_SEGMENTS_PREFIX,
  type SwiftTarget,
} from "../src/Backends/Swift/Utils.ts";
import { InvalidPart } from "../src/Services/Backend.ts";
import { Checksum } from "../src/Services/Checksum.ts";
import { S3HeaderService } from "../src/Services/S3HeaderService.ts";
import { EffectAssert, testEffect } from "./utils.ts";

testEffect(
  "swift multipart complete rejects segment with size 0",
  () =>
    Effect.gen(function* () {
      const uploadId = "test-upload-id";
      const key = "test-key";
      const segmentKey = `${MP_SEGMENTS_PREFIX}${uploadId}/1`;

      const mockStore = KeyValueStore.make({
        get: (k) =>
          Effect.succeed(
            k === `${key}/${uploadId}` ? Option.some("{}") : Option.none(),
          ),
        getUint8Array: () => Effect.succeed(Option.none()),
        set: () => Effect.void,
        remove: () => Effect.void,
        clear: Effect.void,
        size: Effect.succeed(0),
      });

      const segmentWithZeroSize = {
        key: segmentKey,
        size: 0,
        lastModified: new Date(),
        etag: "",
        storageClass: "STANDARD" as const,
        owner: { id: "swift", displayName: "Swift User" },
      };

      const objectOps = {
        listObjects: () =>
          Effect.succeed({
            name: "test-container",
            maxKeys: 1000,
            isTruncated: false,
            contents: [segmentWithZeroSize],
            commonPrefixes: [],
            listType: 1 as const,
          }),
        headObject: () =>
          Effect.die(new Error("headObject should not be called")),
      };

      const headerService = yield* S3HeaderService;
      const checksumService = yield* Checksum;
      const client = yield* HttpClient.HttpClient;

      const target: SwiftTarget = {
        url: "http://localhost",
        token: "x",
        container: "test-container",
        storageUrl: "http://localhost",
        client,
        headerService,
        checksumService,
      };

      const multipartOps = makeMultipartOps(target, mockStore, objectOps);

      const exit = yield* multipartOps.completeMultipartUpload(
        key,
        uploadId,
        [{ partNumber: 1, etag: '"etag1"' }],
        {},
        {},
      ).pipe(Effect.exit);

      yield* EffectAssert.strictEqual(Exit.isFailure(exit), true);
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      yield* EffectAssert.strictEqual(
        failure instanceof InvalidPart,
        true,
      );
      if (failure instanceof InvalidPart) {
        yield* EffectAssert.strictEqual(
          failure.message.includes("size 0") ||
            failure.message.includes("at least 1 byte"),
          true,
        );
      }
    }).pipe(
      Effect.provide(S3HeaderService.Default),
      Effect.provide(Checksum.Default),
      Effect.provide(FetchHttpClient.layer),
    ),
);
