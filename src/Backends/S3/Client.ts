import { S3Client as S3ClientSDK } from "@aws-sdk/client-s3";
import { Cache, Effect } from "effect";
import { HeraldConfig, HeraldConfigLive } from "../../Config/Layer.ts";
import type { MaterializedBucket } from "../../Domain/Config.ts";

export class S3ClientFactory
  extends Effect.Service<S3ClientFactory>()("S3ClientFactory", {
    dependencies: [HeraldConfigLive],
    effect: Effect.gen(function* () {
      const appConfig = yield* HeraldConfig;

      const cache = yield* Cache.make({
        capacity: 100,
        timeToLive: "24 hours", // S3 clients can live a long time
        lookup: (resolved: MaterializedBucket) =>
          Effect.gen(function* () {
            if (resolved.endpoint === undefined) {
              return yield* Effect.fail(
                new Error(
                  `Missing endpoint for backend ${resolved.backend_id}`,
                ),
              );
            }

            if (resolved.region === undefined) {
              return yield* Effect.fail(
                new Error(`Missing region for backend ${resolved.backend_id}`),
              );
            }

            let accessKeyId: string | undefined;
            let secretAccessKey: string | undefined;

            if (resolved.credentials) {
              const creds = resolved.credentials;
              if ("accessKeyId" in creds) {
                accessKeyId = creds.accessKeyId;
                secretAccessKey = creds.secretAccessKey;
              } else if ("username" in creds) {
                accessKeyId = creds.username;
                secretAccessKey = creds.password;
              }

              if (accessKeyId === undefined) {
                return yield* Effect.fail(
                  new Error(
                    `Missing accessKeyId/username for backend ${resolved.backend_id}`,
                  ),
                );
              }
              if (secretAccessKey === undefined) {
                return yield* Effect.fail(
                  new Error(
                    `Missing secretAccessKey/password for backend ${resolved.backend_id}`,
                  ),
                );
              }
            }

            return new S3ClientSDK({
              endpoint: resolved.endpoint,
              region: resolved.region,
              credentials: accessKeyId && secretAccessKey
                ? {
                  accessKeyId,
                  secretAccessKey,
                }
                : undefined,
              forcePathStyle: true,
              // requestChecksumCalculation: "WHEN_REQUIRED",
              // responseChecksumValidation: "WHEN_REQUIRED",
            });
          }),
      });

      return {
        getClient: (bucket: MaterializedBucket | { backend_id: string }) => {
          // Resolve full bucket if only backend_id provided
          let resolved: MaterializedBucket;
          if ("bucket_name" in bucket) {
            resolved = bucket;
          } else {
            const backendConfig = appConfig.raw.backends[bucket.backend_id];
            if (backendConfig && backendConfig.protocol === "s3") {
              resolved = {
                name: "",
                backend_id: bucket.backend_id,
                protocol: "s3" as const,
                endpoint: backendConfig.endpoint,
                region: backendConfig.region,
                bucket_name: "",
                credentials: backendConfig.credentials,
              };
            } else {
              return Effect.fail(
                new Error(
                  `Backend ${bucket.backend_id} is not an S3 backend or not found`,
                ),
              );
            }
          }

          return cache.get(resolved);
        },
      };
    }),
  }) {}
