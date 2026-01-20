import { Context, Effect, Layer, type Schema } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
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
  Effect.gen(function* () {
    const appConfig = yield* AppConfig;
    const client = yield* HttpClient.HttpClient;
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

      const requestBody = {
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
      };

      return Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(`${auth_url}/auth/tokens`)
          .pipe(
            HttpClientRequest.bodyJson(requestBody),
            Effect.mapError((e) => new Error(String(e))),
          );
        const response = yield* client.execute(request).pipe(
          Effect.mapError((e) => new Error(String(e))),
        );

        if (response.status < 200 || response.status >= 300) {
          const msg = yield* response.text.pipe(
            Effect.orElseSucceed(() => "Unknown error"),
          );
          return yield* Effect.fail(
            new Error(`Failed to authenticate with Swift: ${msg}`),
          );
        }

        const token = response.headers["x-subject-token"];
        const tokenStr = Array.isArray(token) ? token[0] : token;

        if (!tokenStr) {
          return yield* Effect.fail(
            new Error(
              "X-Subject-Token header missing from Swift response",
            ),
          );
        }

        const body = (yield* response.json.pipe(
          Effect.mapError((e) => new Error(String(e))),
        )) as SwiftTokenResponse;

        const catalog = body.token.catalog;
        const storageService = catalog.find((s) => s.type === "object-store");

        if (!storageService) {
          return yield* Effect.fail(
            new Error(
              "Object Store service not found in Swift catalog",
            ),
          );
        }

        const endpoint = storageService.endpoints.find(
          (e) =>
            (region ? e.region === region : true) &&
            e.interface === "public",
        );

        if (!endpoint) {
          return yield* Effect.fail(
            new Error(
              `Public Swift endpoint not found (region: ${region ?? "any"})`,
            ),
          );
        }

        return {
          token: tokenStr,
          storageUrl: endpoint.url,
        };
      });
    };

    return SwiftClient.of({
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

        const cacheKey = `${backend_id}:${config.auth_url}:${config.region}`;
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
    });
  }),
);
