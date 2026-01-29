import { S3Client as S3ClientSDK } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Cache, Effect } from "effect";
import { HeraldConfig } from "../../Config/Layer.ts";
import type { MaterializedBucket } from "../../Domain/Config.ts";

/**
 * Generate a stable cache key from MaterializedBucket configuration.
 * The key is based on the fields that determine S3 client configuration:
 * backend_id, endpoint, region, and credentials.
 */
const getCacheKey = (resolved: MaterializedBucket): string => {
  let accessKeyId: string | undefined;
  if (resolved.credentials) {
    const creds = resolved.credentials;
    if ("accessKeyId" in creds) {
      accessKeyId = creds.accessKeyId;
    } else if ("username" in creds) {
      accessKeyId = creds.username;
    }
  }
  // Create a stable key from the configuration that determines the S3 client
  return JSON.stringify({
    backend_id: resolved.backend_id,
    endpoint: resolved.endpoint ?? null,
    region: resolved.region ?? null,
    accessKeyId: accessKeyId ?? null,
  });
};

export class S3ClientFactory
  extends Effect.Service<S3ClientFactory>()("S3ClientFactory", {
    effect: Effect.gen(function* () {
      const appConfig = yield* HeraldConfig;

      const cache = yield* Cache.make({
        capacity: 100,
        timeToLive: "24 hours", // S3 clients can live a long time
        lookup: (cacheKey: string) =>
          Effect.gen(function* () {
            // Parse the cache key to get the configuration
            const config = JSON.parse(cacheKey) as {
              backend_id: string;
              endpoint: string | null;
              region: string | null;
              accessKeyId: string | null;
            };

            if (config.endpoint === null) {
              return yield* Effect.fail(
                new Error(
                  `Missing endpoint for backend ${config.backend_id}`,
                ),
              );
            }

            if (config.region === null) {
              return yield* Effect.fail(
                new Error(`Missing region for backend ${config.backend_id}`),
              );
            }

            // Get credentials from the backend config
            const backendConfig = appConfig.raw.backends[config.backend_id];
            let accessKeyId: string | undefined;
            let secretAccessKey: string | undefined;

            if (backendConfig?.credentials) {
              const creds = backendConfig.credentials;
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
                    `Missing accessKeyId/username for backend ${config.backend_id}`,
                  ),
                );
              }
              if (secretAccessKey === undefined) {
                return yield* Effect.fail(
                  new Error(
                    `Missing secretAccessKey/password for backend ${config.backend_id}`,
                  ),
                );
              }
            }

            return new S3ClientSDK({
              endpoint: config.endpoint,
              region: config.region,
              credentials: accessKeyId && secretAccessKey
                ? {
                  accessKeyId,
                  secretAccessKey,
                }
                : undefined,
              forcePathStyle: true,
              // we must rely on the node impl due to https://github.com/aws/aws-sdk-js-v3/issues/6770
              requestHandler: new NodeHttpHandler(),
              // requestStreamBufferSize: 64 * 1024,
              // requestHandler: new NodeHttpHandler(),
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

          // Use stable cache key instead of the object itself
          const cacheKey = getCacheKey(resolved);
          return cache.get(cacheKey);
        },
      };
    }),
  }) {}
