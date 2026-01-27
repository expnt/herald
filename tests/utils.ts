import { S3Client } from "@aws-sdk/client-s3";
import { Config, Effect, Layer, Logger, LogLevel, Option } from "effect";
import { HttpHeraldLive } from "../src/Http.ts";
import { HeraldConfig } from "../src/Config/Layer.ts";
import { lookupBucket, resolveAuthConfig } from "../src/Domain/Config.ts";
import { BackendResolver } from "../src/Services/BackendResolver.ts";
import { S3ClientFactory } from "../src/Backends/S3/Client.ts";
import { SwiftClient } from "../src/Backends/Swift/Client.ts";
import { S3XmlLive } from "../src/Services/S3Xml.ts";
import { Checksum } from "../src/Services/Checksum.ts";
import { S3HeaderService } from "../src/Services/S3HeaderService.ts";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { FetchHttpClient } from "@effect/platform";
import type { GlobalConfig } from "../src/Domain/Config.ts";
import { assert, assertEquals } from "@std/assert";
import { assertSnapshot } from "@std/testing/snapshot";

export { assert, assertEquals };

export const EffectAssert = {
  strictEqual: <A>(actual: A, expected: A, message?: string) =>
    Effect.sync(() => {
      assertEquals(actual, expected, message);
    }),
  deepStrictEqual: <A>(actual: A, expected: A, message?: string) =>
    Effect.sync(() => {
      assertEquals(actual, expected, message);
    }),
};

export type Snapshot = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export const makeTestHarness = (
  config: GlobalConfig,
  loggingLayer: Layer.Layer<never, never, never> = Logger.minimumLogLevel(
    Deno.env.get("HERALD_LOG_LEVEL") === "debug"
      ? LogLevel.Debug
      : LogLevel.Info,
  ),
) =>
  Effect.gen(function* () {
    const testCredentials = {
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    };

    // Ensure auth is configured so tests don't fail due to "Deny by default" policy
    const configWithAuth: GlobalConfig = {
      ...config,
      auth: config.auth ?? {
        accessKeysRefs: [
          "test",
          "main",
          "alt",
          "tenant",
          "iam",
          "iam_root",
          "iam_alt_root",
        ],
      },
    };

    const HeraldConfigLive = Layer.succeed(HeraldConfig, {
      raw: configWithAuth,
      lookupBucket: (name: string) => lookupBucket(configWithAuth, name),
      resolveAuth: (bucketName: string) => {
        const auth = resolveAuthConfig(configWithAuth, bucketName);
        if (!auth) return Option.none();
        // Mock resolution for test ref
        return Option.some(auth.accessKeysRefs.map((ref) =>
          ref === "test"
            ? testCredentials
            : { accessKeyId: ref, secretAccessKey: ref }
        ));
      },
      resolveAuthForBackendId: (backendId: string) => {
        const backend = configWithAuth.backends[backendId];
        const auth = backend?.auth ?? configWithAuth.auth;
        if (!auth) {
          return Option.none();
        }
        return Option.some(auth.accessKeysRefs.map((ref) =>
          ref === "test"
            ? testCredentials
            : { accessKeyId: ref, secretAccessKey: ref }
        ));
      },
    });

    const ApiWithRequirements = HttpHeraldLive.pipe(
      Layer.provide(BackendResolver.Default),
      Layer.provide(S3ClientFactory.Default),
      Layer.provide(SwiftClient.Default),
      Layer.provide(S3XmlLive),
      Layer.provide(Checksum.Default),
      Layer.provide(S3HeaderService.Default),
      Layer.provide(HeraldConfigLive),
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(HttpServer.layerContext),
      Layer.provideMerge(loggingLayer),
    );

    // In @effect/platform 0.90.x, toWebHandler returns the object directly, not an Effect.
    const webHandler = HttpApiBuilder.toWebHandler(ApiWithRequirements);

    // Start Deno.serve on a random port
    const server = Deno.serve(
      {
        port: 0,
        onListen: () => {},
        onError: (e) => {
          // Suppress Interrupted errors - these happen when requests are aborted
          if (e instanceof Deno.errors.Interrupted) {
            return new Response("Request Interrupted", { status: 499 });
          }
          // Using console.error here is necessary for debugging test failures
          // deno-lint-ignore no-console
          console.error("Server error:", e);
          return new Response("Internal Server Error", { status: 500 });
        },
      },
      async (req) => {
        try {
          return await webHandler.handler(req);
        } catch (e) {
          // Suppress Interrupted errors
          if (e instanceof Deno.errors.Interrupted) {
            return new Response("Request Interrupted", { status: 499 });
          }
          // deno-lint-ignore no-console
          console.error("Handler error:", e);
          return new Response("Internal Server Error", { status: 500 });
        }
      },
    );

    // Ensure cleanup
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        try: () =>
          server.shutdown(),
        catch: (e) =>
          new Error(`Server shutdown failed: ${e}`),
      }).pipe(Effect.orDie)
    );
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        try: () =>
          webHandler.dispose(),
        catch: (e) => new Error(`Web handler disposal failed: ${e}`),
      }).pipe(Effect.orDie)
    );

    const proxyUrl = `http://localhost:${server.addr.port}`;
    const minioUrl = "http://localhost:9000";

    const credentials = {
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    };

    let lastResponse: Snapshot | undefined;

    // Custom fetch to capture response
    const capturingFetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (Deno.env.get("DEBUG_FETCH")) {
        // deno-lint-ignore no-console
        console.log(`FETCH: ${init?.method || "GET"} ${url}`);
        if (init?.headers) {
          // deno-lint-ignore no-console
          console.log(`HEADERS: ${JSON.stringify(init.headers)}`);
        }
      }
      try {
        const res = await fetch(url, init);
        if (Deno.env.get("DEBUG_FETCH")) {
          // deno-lint-ignore no-console
          console.log(`RESPONSE: ${res.status}`);
        }
        const hasBody = res.status !== 204 && res.status !== 205 &&
          res.status !== 304;
        let body = "";
        if (hasBody) {
          body = await res.text();

          // Sanitize body for snapshots - remove dynamic fields from XML
          body = body
            .replace(
              /<RequestId>[^<]+<\/RequestId>/g,
              "<RequestId>ID</RequestId>",
            )
            .replace(/<HostId>[^<]+<\/HostId>/g, "<HostId>HOST</HostId>")
            .replace(
              /<CreationDate>[^<]+<\/CreationDate>/g,
              "<CreationDate>2026-01-15T00:00:00.000Z</CreationDate>",
            );
        } else {
          // Ensure the body is consumed/cancelled to avoid leaks
          await res.body?.cancel();
        }
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          const lowerK = k.toLowerCase();
          if (
            lowerK !== "date" &&
            lowerK !== "x-amz-request-id" &&
            lowerK !== "x-amz-id-2" &&
            lowerK !== "last-modified" &&
            lowerK !== "etag" &&
            lowerK !== "server" &&
            lowerK !== "x-ratelimit-limit" &&
            lowerK !== "x-ratelimit-remaining" &&
            lowerK !== "x-amz-version-id" &&
            lowerK !== "x-amz-bucket-region" &&
            lowerK !== "transfer-encoding" &&
            lowerK !== "connection"
          ) {
            headers[k] = v;
          }
        });

        lastResponse = {
          status: res.status,
          headers,
          body,
        };

        // Return a new response because we consumed the body
        // S3 SDK is picky about bodies in 200 PUT responses
        // But we should try to provide a body if content-length > 0 or if it's a GET
        const responseBody = (body === "" && !hasBody) ? null : body;

        const responseHeaders = new Headers(res.headers);

        return new Response(responseBody, {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
        });
      } catch (e) {
        throw e;
      }
    };

    const createRequestHandler = () => ({
      handle: async (request: {
        query?: Record<string, string>;
        protocol: string;
        hostname: string;
        port?: number;
        path: string;
        method: string;
        headers: Record<string, string>;
        body?: BodyInit;
      }) => {
        const queryStr =
          (request.query && Object.keys(request.query).length > 0)
            ? "?" +
              Object.entries(request.query).map(([k, v]) =>
                v === "" ? k : `${k}=${v}`
              ).join(
                "&",
              )
            : "";
        const url = `${request.protocol}//${request.hostname}${
          request.port ? `:${request.port}` : ""
        }${request.path}${queryStr}`;
        const res = await capturingFetch(url, {
          method: request.method,
          headers: request.headers,
          body: (request.method === "GET" || request.method === "HEAD" ||
              request.method === "DELETE")
            ? undefined
            : request.body,
          // @ts-ignore: duplex is required for streaming body in fetch
          duplex: "half",
        });

        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });

        return {
          response: {
            statusCode: res.status,
            headers: responseHeaders,
            body: res.body,
          },
        };
      },
    });

    const client = new S3Client({
      endpoint: minioUrl,
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
      requestHandler: createRequestHandler(),
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });

    const proxyClient = new S3Client({
      endpoint: proxyUrl,
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
      requestHandler: createRequestHandler(),
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });

    return {
      proxyUrl,
      minioUrl,
      client,
      proxyClient,
      getLastResponse: () => lastResponse,
    };
  });

/**
 * Runs an Effect as a Deno test.
 */
export const testEffect = <E>(
  name: string,
  effect: (t: Deno.TestContext) => Effect.Effect<void, E, never>,
  options?: Omit<Deno.TestDefinition, "name" | "fn">,
) => {
  Deno.test({
    ...options,
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async (t) => {
      const exit = await Effect.runPromiseExit(
        effect(t) as Effect.Effect<void, E, never>,
      );
      if (exit._tag === "Failure") {
        throw exit.cause;
      }
    },
  });
};

export type ProxyTestCase = {
  name: string;
  config: GlobalConfig;
  fn: (
    client: S3Client,
  ) => Promise<void> | Effect.Effect<void, unknown, never>;
  beforeAll?: (
    client: S3Client,
  ) => Promise<void> | Effect.Effect<void, unknown, never>;
  afterAll?: (
    client: S3Client,
  ) => Promise<void> | Effect.Effect<void, unknown, never>;
  ignore?: boolean;
  only?: boolean;
  skipSnapshot?: boolean;
};

function baselineRunner(tc: ProxyTestCase, t: Deno.TestContext) {
  return Effect.gen(function* () {
    const h = yield* makeTestHarness(tc.config);

    if (tc.beforeAll) {
      const beforeResult = tc.beforeAll(h.client);
      if (Effect.isEffect(beforeResult)) {
        yield* beforeResult;
      } else {
        yield* Effect.tryPromise(() => beforeResult as Promise<void>).pipe(
          Effect.orDie,
        );
      }
    }

    const resultEffect = Effect.gen(function* () {
      const result = tc.fn(h.client);
      if (Effect.isEffect(result)) {
        yield* result;
      } else {
        yield* Effect.tryPromise({
          try: () => result as Promise<void>,
          catch: (e) => new Error(`Test function failed for ${tc.name}: ${e}`),
        });
      }
    });

    yield* resultEffect;

    const lastResponse = h.getLastResponse();
    if (lastResponse && !tc.skipSnapshot) {
      yield* Effect.tryPromise(() =>
        assertSnapshot(t, {
          status: lastResponse.status,
          headers: lastResponse.headers,
        }, { name: `Baseline/${tc.name} metadata` })
      );
      if (lastResponse.body) {
        yield* Effect.tryPromise(() =>
          assertSnapshot(t, lastResponse.body, {
            name: `Baseline/${tc.name} body`,
          })
        );
      }
    }

    if (tc.afterAll) {
      const afterResult = tc.afterAll(h.client);
      if (Effect.isEffect(afterResult)) {
        yield* afterResult;
      } else {
        yield* Effect.tryPromise(() => afterResult as Promise<void>).pipe(
          Effect.orDie,
        );
      }
    }
  }).pipe(
    Effect.tapErrorCause(Effect.logError),
    Effect.scoped,
  );
}

function proxyRunner(tc: ProxyTestCase, t: Deno.TestContext) {
  return Effect.gen(function* () {
    const h = yield* makeTestHarness(tc.config);

    if (tc.beforeAll) {
      const beforeResult = tc.beforeAll(h.proxyClient);
      if (Effect.isEffect(beforeResult)) {
        yield* beforeResult;
      } else {
        yield* Effect.tryPromise(() => beforeResult as Promise<void>).pipe(
          Effect.orDie,
        );
      }
    }

    const resultEffect = Effect.gen(function* () {
      const result = tc.fn(h.proxyClient);
      if (Effect.isEffect(result)) {
        yield* result;
      } else {
        yield* Effect.tryPromise({
          try: () => result as Promise<void>,
          catch: (e) => new Error(`Test function failed for ${tc.name}: ${e}`),
        });
      }
    });

    yield* resultEffect;

    const lastResponse = h.getLastResponse();
    if (lastResponse && !tc.skipSnapshot) {
      yield* Effect.tryPromise(() =>
        assertSnapshot(t, {
          status: lastResponse.status,
          headers: lastResponse.headers,
        }, { name: `Proxy/${tc.name} metadata` })
      );
      if (lastResponse.body) {
        yield* Effect.tryPromise(() =>
          assertSnapshot(t, lastResponse.body, {
            name: `Proxy/${tc.name} body`,
          })
        );
      }
    }

    if (tc.afterAll) {
      const afterResult = tc.afterAll(h.proxyClient);
      if (Effect.isEffect(afterResult)) {
        yield* afterResult;
      } else {
        yield* Effect.tryPromise(() => afterResult as Promise<void>).pipe(
          Effect.orDie,
        );
      }
    }
  }).pipe(
    Effect.tapErrorCause(Effect.logError),
    Effect.scoped,
  );
}

const getSwiftConfig = () =>
  Effect.gen(function* () {
    const authUrl = yield* Config.string("HERALD_SWIFTTEST_AUTH_URL").pipe(
      Config.orElse(() => Config.string("OS_AUTH_URL")),
      Config.withDefault("http://localhost:8080/auth/v1.0"),
      Config.option,
    );

    const username = yield* Config.string("HERALD_SWIFTTEST_OS_USERNAME").pipe(
      Config.orElse(() => Config.string("TF_VAR_OS_USERNAME")),
      Config.orElse(() => Config.string("OS_USERNAME")),
      Config.withDefault("test:tester"),
      Config.option,
    );
    const password = yield* Config.string("HERALD_SWIFTTEST_OS_PASSWORD").pipe(
      Config.orElse(() => Config.string("TF_VAR_OS_PASSWORD")),
      Config.orElse(() => Config.string("OS_PASSWORD")),
      Config.withDefault("testing"),
      Config.option,
    );
    const projectName = yield* Config.string("HERALD_SWIFTTEST_OS_PROJECT_NAME")
      .pipe(
        Config.orElse(() => Config.string("TF_VAR_OS_PROJECT_NAME")),
        Config.orElse(() => Config.string("OS_PROJECT_NAME")),
        Config.option,
      );
    const region = yield* Config.string("HERALD_SWIFTTEST_OS_REGION_NAME").pipe(
      Config.orElse(() => Config.string("TF_VAR_OS_REGION_NAME")),
      Config.orElse(() => Config.string("OS_REGION_NAME")),
      Config.withDefault("dc3-a"),
      Config.option,
    );

    if (
      Option.isNone(username) || Option.isNone(password) ||
      Option.isNone(authUrl)
    ) {
      return Option.none();
    }

    const config: GlobalConfig = {
      backends: {
        swift: {
          protocol: "swift",
          auth_url: authUrl.value,
          region: Option.getOrUndefined(region),
          credentials: {
            username: username.value,
            password: password.value,
            project_name: Option.getOrUndefined(projectName),
            user_domain_name: "Default",
            project_domain_name: "Default",
          },
          buckets: "*",
        },
      },
    };
    return Option.some(config);
  });

function swiftRunner(tc: ProxyTestCase, t: Deno.TestContext) {
  return Effect.gen(function* () {
    const swiftConfig = yield* getSwiftConfig();
    if (Option.isNone(swiftConfig)) {
      return yield* Effect.fail(
        new Error(
          "Swift credentials missing. Set HERALD_SWIFTTEST_OS_USERNAME etc or run with infisical.",
        ),
      );
    }

    const h = yield* makeTestHarness(swiftConfig.value);

    if (tc.beforeAll) {
      const beforeResult = tc.beforeAll(h.proxyClient);
      if (Effect.isEffect(beforeResult)) {
        yield* beforeResult;
      } else {
        yield* Effect.tryPromise(() => beforeResult as Promise<void>).pipe(
          Effect.orDie,
        );
      }
    }

    const resultEffect = Effect.gen(function* () {
      const result = tc.fn(h.proxyClient);
      if (Effect.isEffect(result)) {
        yield* result;
      } else {
        yield* Effect.tryPromise({
          try: () => result as Promise<void>,
          catch: (e) => new Error(`Test function failed for ${tc.name}: ${e}`),
        });
      }
    });

    yield* resultEffect;

    const lastResponse = h.getLastResponse();
    if (lastResponse && !tc.skipSnapshot) {
      yield* Effect.tryPromise(() =>
        assertSnapshot(t, {
          status: lastResponse.status,
          headers: lastResponse.headers,
        }, { name: `Swift/${tc.name} metadata` })
      );
      if (lastResponse.body) {
        yield* Effect.tryPromise(() =>
          assertSnapshot(t, lastResponse.body, {
            name: `Swift/${tc.name} body`,
          })
        );
      }
    }

    if (tc.afterAll) {
      const afterResult = tc.afterAll(h.proxyClient);
      if (Effect.isEffect(afterResult)) {
        yield* afterResult;
      } else {
        yield* Effect.tryPromise(() => afterResult as Promise<void>).pipe(
          Effect.orDie,
        );
      }
    }
  }).pipe(
    Effect.tapErrorCause(Effect.logError),
    Effect.scoped,
  );
}

export function harness(cases: ProxyTestCase[]) {
  const namePrefix = "";
  for (const tc of cases) {
    testEffect(
      `${namePrefix}Baseline/${tc.name}`,
      (t) => baselineRunner(tc, t),
      {
        ignore: tc.ignore,
        only: tc.only,
      },
    );
    testEffect(`${namePrefix}Proxy/${tc.name}`, (t) => proxyRunner(tc, t), {
      ignore: tc.ignore,
      only: tc.only,
    });
    testEffect(`${namePrefix}Swift/${tc.name}`, (t) => swiftRunner(tc, t), {
      ignore: tc.ignore,
      only: tc.only,
    });
  }
}
