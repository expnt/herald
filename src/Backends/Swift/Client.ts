import { Context, Effect, Layer, type Schema } from "effect";
import type { MaterializedBucket, SwiftConfig } from "../../Domain/Config.ts";
import { AppConfig } from "../../Config/Layer.ts";

export interface SwiftAuthMeta {
  readonly token: string;
  readonly storageUrl: string;
}

export class SwiftClient extends Context.Tag("SwiftClient")<
  SwiftClient,
  {
    readonly getAuthMeta: (
      bucket: MaterializedBucket | { backend_id: string },
    ) => Effect.Effect<SwiftAuthMeta, Error, never>;
  }
>() {}

interface SwiftEndpoint {
  readonly region: string;
  readonly interface: "public" | "internal" | "admin";
  readonly url: string;
}

interface SwiftService {
  readonly type: string;
  readonly endpoints: readonly SwiftEndpoint[];
}

interface SwiftTokenResponse {
  readonly token: {
    readonly catalog: readonly SwiftService[];
  };
}

export const SwiftClientLive = Layer.effect(
  SwiftClient,
  AppConfig.pipe(
    Effect.flatMap((appConfig) => {
      const cache = new Map<string, SwiftAuthMeta & { expires: number }>();

      const fetchAuthMeta = (
        config: Schema.Schema.Type<typeof SwiftConfig>,
      ): Effect.Effect<SwiftAuthMeta, Error, never> => {
        const { auth_url, credentials, region } = config;

        if (!auth_url) {
          return Effect.fail(
            new Error("auth_url is required for Swift backend"),
          );
        }
        if (!credentials || !("username" in credentials)) {
          return Effect.fail(
            new Error(
              "Swift credentials (username, password, etc.) are required",
            ),
          );
        }

        const {
          username,
          password,
          project_name,
          user_domain_name = "Default",
          project_domain_name = "Default",
        } = credentials;

        const requestBody = JSON.stringify({
          auth: {
            identity: {
              methods: ["password"],
              password: {
                user: {
                  name: username,
                  domain: { name: user_domain_name },
                  password: password,
                },
              },
            },
            scope: {
              project: {
                domain: { name: project_domain_name },
                name: project_name,
              },
            },
          },
        });

        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(`${auth_url}/auth/tokens`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: requestBody,
            });

            if (!response.ok) {
              const msg = await response.text();
              throw new Error(`Failed to authenticate with Swift: ${msg}`);
            }

            const token = response.headers.get("X-Subject-Token");
            if (!token) {
              throw new Error(
                "X-Subject-Token header missing from Swift response",
              );
            }

            const body = (await response.json()) as SwiftTokenResponse;
            const catalog = body.token.catalog;
            const storageService = catalog.find((s) =>
              s.type === "object-store"
            );

            if (!storageService) {
              throw new Error(
                "Object Store service not found in Swift catalog",
              );
            }

            const endpoint = storageService.endpoints.find(
              (e) =>
                (region ? e.region === region : true) &&
                e.interface === "public",
            );

            if (!endpoint) {
              throw new Error(
                `Public Swift endpoint not found (region: ${region ?? "any"})`,
              );
            }

            return {
              token,
              storageUrl: endpoint.url,
            };
          },
          catch: (e) => e as Error,
        });
      };

      return Effect.succeed(
        SwiftClient.of({
          getAuthMeta: (
            bucket: MaterializedBucket | { backend_id: string },
          ) => {
            let backend_id: string;
            let config: Schema.Schema.Type<typeof SwiftConfig>;

            if ("protocol" in bucket) {
              backend_id = bucket.backend_id;
              config = appConfig.raw.backends[backend_id] as Schema.Schema.Type<
                typeof SwiftConfig
              >;
            } else {
              backend_id = bucket.backend_id;
              config = appConfig.raw.backends[backend_id] as Schema.Schema.Type<
                typeof SwiftConfig
              >;
            }

            if (!config || config.protocol !== "swift") {
              return Effect.fail(
                new Error(`Backend ${backend_id} is not a Swift backend`),
              );
            }

            const cacheKey =
              `${backend_id}:${config.auth_url}:${config.region}`;
            const cached = cache.get(cacheKey);
            const now = Date.now();

            if (cached && cached.expires > now) {
              return Effect.succeed({
                token: cached.token,
                storageUrl: cached.storageUrl,
              });
            }

            return fetchAuthMeta(config).pipe(
              Effect.tap((meta) => {
                // Cache for 50 minutes (Swift tokens usually last 1h)
                cache.set(cacheKey, {
                  ...meta,
                  expires: now + 50 * 60 * 1000,
                });
              }),
            );
          },
        }),
      );
    }),
  ),
);
