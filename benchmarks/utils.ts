import { S3Client } from "@aws-sdk/client-s3";
import { Config, Effect, Layer, Logger, LogLevel, Option, Scope } from "effect";
import { HttpHeraldLive } from "../src/Http.ts";
import { HeraldConfig } from "../src/Config/Layer.ts";
import { lookupBucket } from "../src/Domain/Config.ts";
import { BackendResolver } from "../src/Services/BackendResolver.ts";
import { S3ClientFactory } from "../src/Backends/S3/Client.ts";
import { SwiftClient } from "../src/Backends/Swift/Client.ts";
import { S3XmlLive } from "../src/Services/S3Xml.ts";
import { Checksum } from "../src/Services/Checksum.ts";
import { S3HeaderService } from "../src/Services/S3HeaderService.ts";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { GlobalConfig } from "../src/Domain/Config.ts";

export type BenchmarkCase = {
  name: string;
  config: GlobalConfig;
  fn: (client: S3Client, b: Deno.BenchContext) => Promise<void>;
  // For direct comparisons that don't use S3 SDK
  directSwiftFn?: (
    target: { url: string; token: string; container: string },
    client: HttpClient.HttpClient,
    b: Deno.BenchContext,
  ) => Promise<void>;
  setup?: (client: S3Client) => Promise<void>;
  teardown?: (client: S3Client) => Promise<void>;
  group?: string;
  baseline?: boolean;
  ignore?: boolean;
  only?: boolean;
};

export const getSwiftConfig = () =>
  Effect.gen(function* () {
    const authUrl = yield* Config.string("HERALD_SWIFTTEST_AUTH_URL").pipe(
      Config.orElse(() => Config.string("OS_AUTH_URL")),
      Config.withDefault("http://localhost:8081/auth/v1.0"),
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

export interface BenchHarness {
  proxyUrl: string;
  backendUrl: string;
  directClient: S3Client;
  proxyClient: S3Client;
  // Raw swift target for direct comparisons
  swiftTarget?: { url: string; token: string; container: string };
  httpClient?: HttpClient.HttpClient;
}

export const makeBenchHarness = (
  config: GlobalConfig,
): Effect.Effect<BenchHarness, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const benchCredentials = {
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    };

    const HeraldConfigLive = Layer.succeed(HeraldConfig, {
      raw: config,
      lookupBucket: (name: string) => lookupBucket(config, name),
      resolveAuth: () => Option.some([benchCredentials]),
      resolveAuthForBackendId: () => Option.some([benchCredentials]),
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
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, {
        // @ts-ignore: duplex is required for streaming body in fetch
        duplex: "half",
      })),
      Layer.provideMerge(HttpServer.layerContext),
      Layer.provideMerge(Logger.minimumLogLevel(LogLevel.None)),
    );

    const webHandler = HttpApiBuilder.toWebHandler(ApiWithRequirements);

    const server = Deno.serve(
      { port: 0, onListen: () => {} },
      async (req) => {
        try {
          return await webHandler.handler(req);
        } catch (_e) {
          return new Response("Internal Server Error", { status: 500 });
        }
      },
    );

    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => server.shutdown()).pipe(Effect.orDie)
    );
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => webHandler.dispose()).pipe(Effect.orDie)
    );

    const proxyUrl = `http://localhost:${server.addr.port}`;
    const backendUrl = "http://localhost:9100";
    const credentials = {
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    };

    const directClient = new S3Client({
      endpoint: backendUrl,
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });

    const proxyClient = new S3Client({
      endpoint: proxyUrl,
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });

    let swiftTarget: BenchHarness["swiftTarget"] = undefined;
    let httpClient: HttpClient.HttpClient | undefined = undefined;

    // If swift is configured, get a token for direct benchmarks
    const swiftBackendId = Object.keys(config.backends).find((k) =>
      config.backends[k].protocol === "swift"
    );
    if (swiftBackendId) {
      const swiftClient = yield* SwiftClient;
      const authMeta = yield* swiftClient.getAuthMeta({
        backend_id: swiftBackendId,
      });
      swiftTarget = {
        url: authMeta.storageUrl,
        token: authMeta.token,
        container: "bench-bucket", // Fixed for bench
      };
      httpClient = yield* HttpClient.HttpClient;
    }

    return {
      proxyUrl,
      backendUrl,
      directClient,
      proxyClient,
      swiftTarget,
      httpClient,
    };
  }).pipe(
    // We need to provide the requirements for SwiftClient and HttpClient
    Effect.provide(SwiftClient.Default),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(Layer.succeed(FetchHttpClient.RequestInit, {
      // @ts-ignore: duplex is required for streaming body in fetch
      duplex: "half",
    })),
    Effect.provide(
      Layer.succeed(HeraldConfig, {
        raw: config,
        lookupBucket: (name: string) => lookupBucket(config, name),
        resolveAuth: () =>
          Option.some([{
            accessKeyId: "minioadmin",
            secretAccessKey: "minioadmin",
          }]),
        resolveAuthForBackendId: () =>
          Option.some([{
            accessKeyId: "minioadmin",
            secretAccessKey: "minioadmin",
          }]),
      }),
    ),
  );

// Global state for harnesses to avoid iterative restarts
let backendHarness: BenchHarness | null = null;
let swiftHarness: BenchHarness | null = null;
let globalScope: Scope.Scope | null = null;

// Check swift config once at the beginning
const swiftConfigOpt = await Effect.runPromise(getSwiftConfig());

async function ensureHarnesses(bc: BenchmarkCase) {
  if (globalScope) return;

  globalScope = Effect.runSync(Scope.make());

  backendHarness = await Effect.runPromise(
    makeBenchHarness(bc.config).pipe(
      Effect.provideService(Scope.Scope, globalScope),
    ),
  );

  if (Option.isSome(swiftConfigOpt)) {
    swiftHarness = await Effect.runPromise(
      makeBenchHarness(swiftConfigOpt.value).pipe(
        Effect.provideService(Scope.Scope, globalScope),
      ),
    );
  }
}

export function benchmarkHarness(cases: BenchmarkCase[]) {
  for (const bc of cases) {
    const operationName = `${bc.group ? `${bc.group}/` : ""}${bc.name}`;
    const s3Group = `${operationName} (S3)`;
    const swiftGroup = `${operationName} (Swift)`;

    // 1. Baseline (Direct RustFS)
    Deno.bench({
      name: `RustFS-Direct`,
      group: s3Group,
      ignore: bc.ignore,
      only: bc.only,
      fn: async (b) => {
        await ensureHarnesses(bc);
        const client = backendHarness!.directClient;

        try {
          if (bc.setup) await bc.setup(client);
        } catch (e) {
          throw new Error(`Setup failed for ${operationName} (Baseline): ${e}`);
        }

        await bc.fn(client, b);

        if (bc.teardown) {
          await bc.teardown(client).catch(() => {});
        }
      },
    });

    // 2. Proxy (Herald + RustFS)
    Deno.bench({
      name: `Herald-Proxy`,
      baseline: true,
      group: s3Group,
      ignore: bc.ignore,
      only: bc.only,
      fn: async (b) => {
        await ensureHarnesses(bc);
        const client = backendHarness!.proxyClient;

        try {
          if (bc.setup) await bc.setup(client);
        } catch (e) {
          throw new Error(`Setup failed for ${operationName} (Proxy): ${e}`);
        }

        await bc.fn(client, b);

        if (bc.teardown) {
          await bc.teardown(client).catch(() => {});
        }
      },
    });

    // 3. Swift Proxy (Herald + Swift)
    Deno.bench({
      name: `Swift-Proxy`,
      group: swiftGroup,
      baseline: true,
      ignore: bc.ignore || Option.isNone(swiftConfigOpt),
      only: bc.only,
      fn: async (b) => {
        await ensureHarnesses(bc);
        if (!swiftHarness) return;
        const client = swiftHarness.proxyClient;

        try {
          if (bc.setup) await bc.setup(client);
        } catch (e) {
          throw new Error(
            `Setup failed for ${operationName} (Swift-Proxy): ${e}`,
          );
        }

        await bc.fn(client, b);

        if (bc.teardown) {
          await bc.teardown(client).catch(() => {});
        }
      },
    });

    // 4. Swift Direct (Raw Swift API)
    if (bc.directSwiftFn) {
      Deno.bench({
        name: `Swift-Direct`,
        group: swiftGroup,
        ignore: bc.ignore || Option.isNone(swiftConfigOpt),
        only: bc.only,
        fn: async (b) => {
          await ensureHarnesses(bc);
          if (
            !swiftHarness || !swiftHarness.swiftTarget ||
            !swiftHarness.httpClient
          ) return;

          try {
            if (bc.setup) await bc.setup(swiftHarness.proxyClient);
          } catch (e) {
            throw new Error(
              `Setup failed for ${operationName} (Swift-Direct): ${e}`,
            );
          }

          await bc.directSwiftFn!(
            swiftHarness.swiftTarget,
            swiftHarness.httpClient,
            b,
          );

          if (bc.teardown) {
            await bc.teardown(swiftHarness.proxyClient).catch(() => {});
          }
        },
      });
    }
  }
}
