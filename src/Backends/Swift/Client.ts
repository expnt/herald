import { Cache, Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { MaterializedBucket } from "../../Domain/Config.ts";
import type { SwiftConfig } from "../../Domain/Config.ts";
import { HeraldConfig } from "../../Config/Layer.ts";

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

const SwiftEndpoint = Schema.Struct({
  region: Schema.String,
  interface: Schema.Literal("public", "internal", "admin"),
  url: Schema.String,
});

const SwiftService = Schema.Struct({
  type: Schema.String,
  endpoints: Schema.Array(SwiftEndpoint),
});

const SwiftTokenResponse = Schema.Struct({
  token: Schema.Struct({
    catalog: Schema.Array(SwiftService),
  }),
});

export const SwiftClientLive = Layer.effect(
  SwiftClient,
  Effect.gen(function* () {
    const appConfig = yield* HeraldConfig;
    const client = yield* HttpClient.HttpClient;

    const fetchAuthMeta = (
      config: Schema.Schema.Type<typeof SwiftConfig>,
    ): Effect.Effect<SwiftAuthMeta, Error, never> => {
      const { auth_url, credentials, region } = config;

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

      const isV1 = auth_url.endsWith("/v1.0") || !project_name;

      if (isV1) {
        return Effect.gen(function* () {
          const request = HttpClientRequest.get(auth_url).pipe(
            HttpClientRequest.setHeaders({
              "X-Auth-User": username || "",
              "X-Auth-Key": password || "",
            }),
          );
          const response = yield* client.execute(request).pipe(
            Effect.mapError((e) => new Error(String(e))),
          );

          if (response.status < 200 || response.status >= 300) {
            const msg = yield* response.text.pipe(
              Effect.orElseSucceed(() => "Unknown error"),
            );
            return yield* Effect.fail(
              new Error(`Failed to authenticate with Swift v1.0: ${msg}`),
            );
          }

          const token = response.headers["x-auth-token"];
          const storageUrl = response.headers["x-storage-url"];

          const tokenStr = Array.isArray(token) ? token[0] : (token || "");
          const storageUrlStr = Array.isArray(storageUrl)
            ? storageUrl[0]
            : (storageUrl || "");

          if (!tokenStr || !storageUrlStr) {
            return yield* Effect.fail(
              new Error(
                "X-Auth-Token or X-Storage-Url header missing from Swift v1.0 response",
              ),
            );
          }

          return {
            token: tokenStr,
            storageUrl: storageUrlStr,
          };
        }).pipe(
          Effect.mapError((e) => e instanceof Error ? e : new Error(String(e))),
        );
      }

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

        const json = yield* response.json.pipe(
          Effect.mapError((e) => new Error(String(e))),
        );
        const body = yield* Schema.decodeUnknown(SwiftTokenResponse)(json).pipe(
          Effect.mapError((e) =>
            new Error(`Failed to parse Swift token response: ${e}`)
          ),
        );

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

    const cache = yield* Cache.make({
      capacity: 100,
      lookup: (config: Schema.Schema.Type<typeof SwiftConfig>) =>
        fetchAuthMeta(config),
      timeToLive: "50 minutes", // Swift tokens usually last 1h
    });

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

        return cache.get(config);
      },
    });
  }),
);
