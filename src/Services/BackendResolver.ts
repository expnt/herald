import { Cache, Context, Effect, Layer, Option } from "effect";
import { HeraldConfig } from "../Config/Layer.ts";
import { Backend } from "./Backend.ts";
import type { S3Client } from "../Backends/S3/Client.ts";
import { makeS3Backend } from "../Backends/S3/Backend.ts";
import { makeSwiftBackend } from "../Backends/Swift/Backend.ts";
import type { SwiftClient } from "../Backends/Swift/Client.ts";
import type { MaterializedBucket } from "../Domain/Config.ts";

/**
 * BackendResolver handles dynamic resolution and provisioning of Backend implementations
 * based on configuration context (bucket name or backend ID).
 */
export class BackendResolver extends Context.Tag("BackendResolver")<
  BackendResolver,
  {
    readonly provideForBucket: <A, E, R>(
      bucketName: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | Error,
      Exclude<R, Backend> | HeraldConfig | S3Client | SwiftClient
    >;

    readonly provideForBackendId: <A, E, R>(
      backendId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | Error,
      Exclude<R, Backend> | HeraldConfig | S3Client | SwiftClient
    >;
  }
>() {}

export const BackendResolverLive = Layer.effect(
  BackendResolver,
  Effect.gen(function* () {
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

    // We cache by the string identifier (bucket name or backend ID).
    // The BackendService itself is request-scoped because makeBackend yields requirements
    // that are resolved from the current context when the cache is lookep up.
    // Wait, Cache.get(key) will execute the lookup if not present.
    // If we want the BackendService to be truly request-scoped but cached,
    // we have a conflict if the requirements (like HeraldConfig) change per request.
    // However, in Herald, HeraldConfig is usually a singleton for the app.
    // If it's a singleton, then caching the BackendService is fine.

    const bucketCache = yield* Cache.make({
      capacity: 100,
      timeToLive: "24 hours",
      lookup: (bucketName: string) =>
        Effect.gen(function* () {
          const matched = config.lookupBucket(bucketName);
          if (Option.isNone(matched)) {
            return yield* Effect.fail(
              new Error(`No configuration found for bucket: ${bucketName}`),
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
      provideForBucket: <A, E, R>(
        bucketName: string,
        effect: Effect.Effect<A, E, R>,
      ) =>
        Effect.gen(function* () {
          const backendImpl = yield* bucketCache.get(bucketName);
          return yield* Effect.provideService(effect, Backend, backendImpl);
        }) as Effect.Effect<
          A,
          E | Error,
          Exclude<R, Backend> | HeraldConfig | S3Client | SwiftClient
        >,

      provideForBackendId: <A, E, R>(
        backendId: string,
        effect: Effect.Effect<A, E, R>,
      ) =>
        Effect.gen(function* () {
          const backendImpl = yield* backendCache.get(backendId);
          return yield* Effect.provideService(effect, Backend, backendImpl);
        }) as Effect.Effect<
          A,
          E | Error,
          Exclude<R, Backend> | HeraldConfig | S3Client | SwiftClient
        >,
    };
  }),
);
