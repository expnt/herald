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
                return Effect.fail(
                  new Error(
                    `Missing accessKeyId/username for backend ${resolved.backend_id}`,
                  ),
                );
              }
              if (secretAccessKey === undefined) {
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
              credentials: accessKeyId && secretAccessKey
                ? {
                  accessKeyId,
                  secretAccessKey,
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
