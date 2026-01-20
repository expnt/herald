import { Context, Effect, Layer, Option } from "effect";
import { AppConfig } from "../Config/Layer.ts";
import { Backend, type BackendService } from "./Backend.ts";
import type { S3Client } from "../Backends/S3/Client.ts";
import { makeS3Backend } from "../Backends/S3/Backend.ts";
import { makeSwiftBackend } from "../Backends/Swift/Backend.ts";
import type { SwiftClient } from "../Backends/Swift/Client.ts";

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
      Exclude<R, Backend> | AppConfig | S3Client | SwiftClient
    >;

    readonly provideForBackendId: <A, E, R>(
      backendId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | Error,
      Exclude<R, Backend> | AppConfig | S3Client | SwiftClient
    >;
  }
>() {}

export const BackendResolverLive = Layer.effect(
  BackendResolver,
  Effect.gen(function* () {
    const config = yield* AppConfig;

    // Dynamic provision logic with memoization.
    const bucketCache = new Map<string, BackendService>();
    const backendCache = new Map<string, BackendService>();

    return {
      provideForBucket: <A, E, R>(
        bucketName: string,
        effect: Effect.Effect<A, E, R>,
      ) =>
        Effect.gen(function* () {
          if (bucketCache.has(bucketName)) {
            return yield* Effect.provideService(
              effect,
              Backend,
              bucketCache.get(bucketName)!,
            );
          }

          const matched = config.lookupBucket(bucketName);
          if (Option.isNone(matched)) {
            return yield* Effect.fail(
              new Error(`No configuration found for bucket: ${bucketName}`),
            );
          }

          const bucketConfig = matched.value;
          let backendImpl: BackendService;

          if (bucketConfig.protocol === "s3") {
            backendImpl = yield* makeS3Backend(bucketConfig);
          } else if (bucketConfig.protocol === "swift") {
            backendImpl = yield* makeSwiftBackend(bucketConfig);
          } else {
            return yield* Effect.fail(
              new Error(`Unsupported protocol: ${bucketConfig.protocol}`),
            );
          }

          bucketCache.set(bucketName, backendImpl);
          return yield* Effect.provideService(effect, Backend, backendImpl);
        }) as Effect.Effect<
          A,
          E | Error,
          Exclude<R, Backend> | AppConfig | S3Client | SwiftClient
        >,

      provideForBackendId: <A, E, R>(
        backendId: string,
        effect: Effect.Effect<A, E, R>,
      ) =>
        Effect.gen(function* () {
          if (backendCache.has(backendId)) {
            return yield* Effect.provideService(
              effect,
              Backend,
              backendCache.get(backendId)!,
            );
          }

          const backendConfig = config.raw.backends[backendId];
          if (!backendConfig) {
            return yield* Effect.fail(
              new Error(`No configuration found for backend: ${backendId}`),
            );
          }

          let backendImpl: BackendService;

          if (backendConfig.protocol === "s3") {
            backendImpl = yield* makeS3Backend({ backend_id: backendId });
          } else if (backendConfig.protocol === "swift") {
            backendImpl = yield* makeSwiftBackend({ backend_id: backendId });
          } else {
            const protocol = (backendConfig as { protocol: string }).protocol;
            return yield* Effect.fail(
              new Error(`Unsupported protocol: ${protocol}`),
            );
          }

          backendCache.set(backendId, backendImpl);
          return yield* Effect.provideService(effect, Backend, backendImpl);
        }) as Effect.Effect<
          A,
          E | Error,
          Exclude<R, Backend> | AppConfig | S3Client | SwiftClient
        >,
    };
  }),
);
