import { Context, Effect, Layer } from "effect";
import { S3Client as S3ClientSDK } from "@aws-sdk/client-s3";
import type { MaterializedBucket } from "../../Domain/Config.ts";
import { AppConfig } from "../../Config/Layer.ts";

export class S3Client extends Context.Tag("S3Client")<
  S3Client,
  {
    readonly getClient: (
      bucket: MaterializedBucket | { backend_id: string },
    ) => Effect.Effect<S3ClientSDK, Error, never>;
  }
>() {}

export const S3ClientLive = Layer.effect(
  S3Client,
  AppConfig.pipe(
    Effect.flatMap((appConfig) => {
      // A simple cache for SDK clients
      const clients = new Map<string, S3ClientSDK>();

      return Effect.succeed(
        S3Client.of({
          getClient: (bucket: MaterializedBucket | { backend_id: string }) => {
            // Resolve full bucket if only backend_id provided
            let resolved: MaterializedBucket;
            if ("bucket_name" in bucket) {
              resolved = bucket;
            } else {
              const backendConfig = appConfig.raw.backends[bucket.backend_id];
              resolved = {
                name: "",
                backend_id: bucket.backend_id,
                protocol: "s3" as const,
                endpoint: backendConfig.endpoint,
                region: backendConfig.region,
                bucket_name: "",
                credentials: backendConfig.credentials,
              };
            }

            const key =
              `${resolved.backend_id}:${resolved.endpoint}:${resolved.region}`;
            const existing = clients.get(key);
            if (existing) {
              return Effect.succeed(existing);
            }

            if (resolved.endpoint === undefined) {
              return Effect.fail(
                new Error(
                  `Missing endpoint for backend ${resolved.backend_id}`,
                ),
              );
            }

            if (resolved.region === undefined) {
              return Effect.fail(
                new Error(`Missing region for backend ${resolved.backend_id}`),
              );
            }

            if (resolved.credentials) {
              if (
                resolved.credentials.accessKeyId === undefined &&
                resolved.credentials.username === undefined
              ) {
                return Effect.fail(
                  new Error(
                    `Missing accessKeyId/username for backend ${resolved.backend_id}`,
                  ),
                );
              }
              if (
                resolved.credentials.secretAccessKey === undefined &&
                resolved.credentials.password === undefined
              ) {
                return Effect.fail(
                  new Error(
                    `Missing secretAccessKey/password for backend ${resolved.backend_id}`,
                  ),
                );
              }
            }

            const sdkClient = new S3ClientSDK({
              endpoint: resolved.endpoint,
              region: resolved.region,
              credentials: resolved.credentials
                ? {
                  accessKeyId: (resolved.credentials.accessKeyId ??
                    resolved.credentials.username)!,
                  secretAccessKey: (resolved.credentials.secretAccessKey ??
                    resolved.credentials.password)!,
                }
                : undefined,
              forcePathStyle: true,
            });

            clients.set(key, sdkClient);
            return Effect.succeed(sdkClient);
          },
        }),
      );
    }),
  ),
);
