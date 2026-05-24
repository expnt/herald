import { Cache, Effect, Option } from "effect";
import { makeS3Backend } from "../Backends/S3/Backend.ts";
import { makeSwiftBackend } from "../Backends/Swift/Backend.ts";
import { HeraldConfig } from "../Config/Layer.ts";
import type { MaterializedBucket } from "../Domain/Config.ts";
import { NoSuchBucket } from "./Backend.ts";

export class BackendResolver
  extends Effect.Service<BackendResolver>()("BackendResolver", {
    effect: Effect.gen(function* () {
      const config = yield* HeraldConfig;

      const makeBackend = (
        bucketConfig: MaterializedBucket | { backend_id: string },
      ) =>
        Effect.gen(function* () {
          const protocol = "protocol" in bucketConfig
            ? bucketConfig.protocol
            : config.raw.backends[bucketConfig.backend_id]?.protocol;

          if (protocol === "s3") {
            return yield* makeS3Backend(bucketConfig);
          } else if (protocol === "swift") {
            return yield* makeSwiftBackend(bucketConfig);
          } else {
            return yield* Effect.fail(
              new Error(`Unsupported protocol: ${protocol}`),
            );
          }
        });

      const bucketCache = yield* Cache.make({
        capacity: 100,
        timeToLive: "24 hours",
        lookup: (bucketName: string) =>
          Effect.gen(function* () {
            const matched = config.lookupBucket(bucketName);
            if (Option.isNone(matched)) {
              return yield* Effect.fail(
                new NoSuchBucket({
                  bucket: bucketName,
                  message: `No configuration found for bucket: ${bucketName}`,
                }),
              );
            }
            return yield* makeBackend(matched.value);
          }),
      });

      const backendCache = yield* Cache.make({
        capacity: 100,
        timeToLive: "24 hours",
        lookup: (backendId: string) =>
          Effect.gen(function* () {
            const backendConfig = config.raw.backends[backendId];
            if (!backendConfig) {
              return yield* Effect.fail(
                new Error(`No configuration found for backend: ${backendId}`),
              );
            }
            return yield* makeBackend({ backend_id: backendId });
          }),
      });

      return {
        getLayerForBucket: (bucketName: string) =>
          Effect.gen(function* () {
            return yield* bucketCache.get(bucketName);
          }),
        getLayerForBackend: (backendId: string) =>
          Effect.gen(function* () {
            return yield* backendCache.get(backendId);
          }),
      };
    }),
  }) {}
