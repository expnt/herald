import { Effect, Option, Schema } from "effect";
import { assertEquals, testEffect } from "./utils.ts";
import { GlobalConfig, resolveCorsConfig } from "../src/Domain/Config.ts";
import { parseConfig } from "../src/Config/Layer.ts";
import { corsMiddleware } from "../src/Frontend/Cors.ts";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { HeraldConfig } from "../src/Config/Layer.ts";

function makeMockRequest(
  url: string,
  init: RequestInit,
): HttpServerRequest.HttpServerRequest {
  const req = new Request(url, init);
  return {
    method: req.method,
    url: req.url,
    headers: Object.fromEntries(req.headers.entries()),
    remoteAddress: Option.none(),
  } as unknown as HttpServerRequest.HttpServerRequest;
}

testEffect("cors/resolveCorsConfig/inheritance", () =>
  Effect.gen(function* () {
    yield* Effect.void;
    const configInput = {
      cors: {
        allowedOrigins: ["https://global.com"],
        credentials: false,
      },
      backends: {
        s3_main: {
          protocol: "s3",
          cors: {
            allowedOrigins: ["https://backend.com"],
            maxAge: 3600,
          },
          buckets: {
            bucket_with_cors: {
              cors: {
                allowedOrigins: ["https://bucket.com"],
                credentials: true,
              },
            },
            bucket_no_cors: {},
          },
        },
        other: {
          protocol: "s3",
          buckets: "*",
        },
      },
    };

    const config = Schema.decodeUnknownSync(GlobalConfig)(configInput);

    // 1. Bucket level override
    const cors1 = resolveCorsConfig(config, "bucket_with_cors");
    assertEquals(cors1?.allowedOrigins, ["https://bucket.com"]);
    assertEquals(cors1?.credentials, true);
    assertEquals(cors1?.maxAge, 3600); // Inherited from backend

    // 2. Backend level override
    const cors2 = resolveCorsConfig(config, "bucket_no_cors");
    assertEquals(cors2?.allowedOrigins, ["https://backend.com"]);
    assertEquals(cors2?.credentials, false); // Inherited from global
    assertEquals(cors2?.maxAge, 3600);

    // 3. Global level
    const cors3 = resolveCorsConfig(config, "any-other-bucket");
    assertEquals(cors3?.allowedOrigins, ["https://global.com"]);
    assertEquals(cors3?.credentials, false);
    assertEquals(cors3?.maxAge, undefined);
  }));

testEffect("cors/parseConfig/env_vars", () =>
  Effect.gen(function* () {
    yield* Effect.void;
    const env = {
      HERALD_CORS_ALLOWED_ORIGINS: "https://global.com, https://other.com",
      HERALD_CORS_CREDENTIALS: "true",
      HERALD_PROD_PROTOCOL: "s3",
      HERALD_PROD_BUCKETS: "*",
      HERALD_PROD_CORS_ALLOWED_ORIGINS: "https://s3.com",
      HERALD_PROD_CORS_MAX_AGE: "7200",
    };
    const config = parseConfig({ backends: {} }, env);

    assertEquals(config.cors?.allowedOrigins, [
      "https://global.com",
      "https://other.com",
    ]);
    assertEquals(config.cors?.credentials, true);

    const prodBackend = config.backends.prod;
    assertEquals(prodBackend.protocol, "s3");
    assertEquals(prodBackend.cors?.allowedOrigins, ["https://s3.com"]);
    assertEquals(prodBackend.cors?.maxAge, 7200);
  }));

testEffect("cors/parseConfig/yaml_merge", () =>
  Effect.gen(function* () {
    yield* Effect.void;
    const yaml = {
      cors: {
        allowedOrigins: ["https://yaml.com"],
        maxAge: 100,
      },
      backends: {
        s3: {
          protocol: "s3",
          buckets: "*",
          cors: {
            allowedMethods: ["GET"],
          },
        },
      },
    };
    const env = {
      HERALD_CORS_MAX_AGE: "200",
      HERALD_S3_CORS_ALLOWED_METHODS: "POST, PUT",
    };
    const config = parseConfig(yaml, env);

    assertEquals(config.cors?.allowedOrigins, ["https://yaml.com"]);
    assertEquals(config.cors?.maxAge, 200); // Env overrides YAML

    const s3Backend = config.backends.s3;
    assertEquals(s3Backend.cors?.allowedMethods, ["POST", "PUT"]); // Env overrides YAML
  }));

testEffect("cors/middleware/preflight", () =>
  Effect.gen(function* () {
    const config: GlobalConfig = {
      backends: {
        s3: {
          protocol: "s3",
          buckets: "*",
          cors: {
            allowedOrigins: ["https://example.com"],
            allowedMethods: ["GET", "PUT"],
            credentials: true,
          },
        },
      },
    };

    const heraldConfig = {
      raw: config,
      lookupBucket: () => Option.none(),
    };

    const request = makeMockRequest("http://localhost/s3/obj", {
      method: "OPTIONS",
      headers: {
        "origin": "https://example.com",
        "access-control-request-method": "PUT",
      },
    });

    const middleware = corsMiddleware(
      Effect.fail(new Error("Should not reach handler")),
    );

    const response = yield* middleware.pipe(
      // deno-lint-ignore no-explicit-any
      Effect.provideService(HeraldConfig, heraldConfig as any),
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );

    assertEquals(response.status, 204);
    assertEquals(
      response.headers["access-control-allow-origin"],
      "https://example.com",
    );
    assertEquals(response.headers["access-control-allow-methods"], "GET, PUT");
    assertEquals(response.headers["access-control-allow-credentials"], "true");
  }));

testEffect("cors/middleware/headers", () =>
  Effect.gen(function* () {
    const config: GlobalConfig = {
      backends: {
        s3: {
          protocol: "s3",
          buckets: "*",
          cors: {
            allowedOrigins: ["*"],
            exposedHeaders: ["x-amz-meta-custom"],
          },
        },
      },
    };

    const heraldConfig = {
      raw: config,
      lookupBucket: () => Option.none(),
    };

    const request = makeMockRequest("http://localhost/s3/obj", {
      method: "GET",
      headers: { "origin": "https://any.com" },
    });

    const handler = Effect.succeed(HttpServerResponse.empty({ status: 200 }));
    const middleware = corsMiddleware(handler);

    const response = yield* middleware.pipe(
      // deno-lint-ignore no-explicit-any
      Effect.provideService(HeraldConfig, heraldConfig as any),
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );

    assertEquals(response.status, 200);
    assertEquals(response.headers["access-control-allow-origin"], "*");
    assertEquals(
      response.headers["access-control-expose-headers"],
      "x-amz-meta-custom",
    );
  }));
