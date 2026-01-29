import { Effect, Either, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "@effect/platform";
import { S3ClientFactory } from "../src/Backends/S3/Client.ts";
import { SwiftClient } from "../src/Backends/Swift/Client.ts";
import { HeraldConfig, parseConfig } from "../src/Config/Layer.ts";
import {
  GlobalConfig,
  lookupBucket,
  resolveAuthConfig,
} from "../src/Domain/Config.ts";
import { BackendResolver } from "../src/Services/BackendResolver.ts";
import { Checksum } from "../src/Services/Checksum.ts";
import { S3HeaderService } from "../src/Services/S3HeaderService.ts";
import { assertEquals, EffectAssert, testEffect } from "./utils.ts";

interface TestCase {
  id: string;
  name: string;
  input: unknown;
  expectedBuckets?: Record<string, Record<string, unknown>>;
  expectError?: boolean;
}

const cases: TestCase[] = [
  {
    id: "basic_inheritance",
    name: "basic inheritance",
    input: {
      backends: {
        s3_main: {
          protocol: "s3",
          endpoint: "http://s3.amazonaws.com",
          buckets: {
            my_bucket: {},
          },
        },
      },
    },
    expectedBuckets: {
      my_bucket: {
        name: "my_bucket",
        backend_id: "s3_main",
        protocol: "s3",
        endpoint: "http://s3.amazonaws.com",
        bucket_name: "my_bucket",
      },
    },
  },
  {
    id: "bucket_overrides_endpoint",
    name: "bucket overrides endpoint",
    input: {
      backends: {
        s3_main: {
          protocol: "s3",
          endpoint: "http://s3.amazonaws.com",
          buckets: {
            special_bucket: {
              endpoint: "http://custom-endpoint.com",
            },
          },
        },
      },
    },
    expectedBuckets: {
      special_bucket: {
        name: "special_bucket",
        backend_id: "s3_main",
        protocol: "s3",
        endpoint: "http://custom-endpoint.com",
        bucket_name: "special_bucket",
      },
    },
  },
  {
    id: "bucket_overrides_bucket_name",
    name: "bucket overrides bucket_name",
    input: {
      backends: {
        s3_main: {
          protocol: "s3",
          buckets: {
            my_logical_name: {
              bucket_name: "actual-s3-bucket-name",
            },
          },
        },
      },
    },
    expectedBuckets: {
      my_logical_name: {
        name: "my_logical_name",
        backend_id: "s3_main",
        protocol: "s3",
        bucket_name: "actual-s3-bucket-name",
      },
    },
  },
  {
    id: "invalid_protocol",
    name: "invalid protocol fails",
    input: {
      backends: {
        bad: {
          protocol: "not-real",
          buckets: { b: {} },
        },
      },
    },
    expectError: true,
  },
  {
    id: "priority_direct_over_glob",
    name: "direct match takes priority over glob across backends",
    input: {
      backends: {
        fallback: {
          protocol: "s3",
          endpoint: "http://fallback.com",
          buckets: "*",
        },
        specific: {
          protocol: "s3",
          endpoint: "http://specific.com",
          buckets: {
            my_bucket: {},
          },
        },
      },
    },
    expectedBuckets: {
      my_bucket: {
        backend_id: "specific",
        endpoint: "http://specific.com",
      },
    },
  },
  {
    id: "priority_glob_key_over_string",
    name: "glob key takes priority over glob string across backends",
    input: {
      backends: {
        string_glob: {
          protocol: "s3",
          endpoint: "http://string.com",
          buckets: "*",
        },
        key_glob: {
          protocol: "s3",
          endpoint: "http://key.com",
          buckets: {
            "prod-*": {},
          },
        },
      },
    },
    expectedBuckets: {
      "prod-logs": {
        backend_id: "key_glob",
        endpoint: "http://key.com",
      },
    },
  },
  {
    id: "priority_backend_order",
    name: "first backend wins for same priority level",
    input: {
      backends: {
        first: {
          protocol: "s3",
          endpoint: "http://first.com",
          buckets: "*",
        },
        second: {
          protocol: "s3",
          endpoint: "http://second.com",
          buckets: "*",
        },
      },
    },
    expectedBuckets: {
      any_bucket: {
        backend_id: "first",
        endpoint: "http://first.com",
      },
    },
  },
  {
    id: "complex_glob_matching",
    name: "complex glob matching (prefix, suffix, infix)",
    input: {
      backends: {
        s3: {
          protocol: "s3",
          buckets: {
            "logs-*": { bucket_name: "prefix-match" },
            "*-backups": { bucket_name: "suffix-match" },
            "data-*-internal": { bucket_name: "infix-match" },
          },
        },
      },
    },
    expectedBuckets: {
      "logs-2024": { bucket_name: "prefix-match" },
      "db-backups": { bucket_name: "suffix-match" },
      "data-customer-internal": { bucket_name: "infix-match" },
    },
  },
  {
    id: "swift_basic",
    name: "swift basic config",
    input: {
      backends: {
        swift_main: {
          protocol: "swift",
          auth_url: "http://keystone.example.com",
          container: "my-container",
          buckets: "*",
        },
      },
    },
    expectedBuckets: {
      "any-bucket": {
        backend_id: "swift_main",
        protocol: "swift",
        auth_url: "http://keystone.example.com",
        container: "my-container",
      },
    },
  },
  {
    id: "swift_with_credentials",
    name: "swift with credentials",
    input: {
      backends: {
        swift_main: {
          protocol: "swift",
          auth_url: "http://keystone.example.com",
          credentials: {
            username: "user1",
            password: "pw1",
            project_name: "proj1",
          },
        },
      },
    },
    expectedBuckets: {
      "any": {
        backend_id: "swift_main",
        protocol: "swift",
      },
    },
  },
  {
    id: "priority_full_hierarchy",
    name: "full priority hierarchy (direct > map-glob > string-glob)",
    input: {
      backends: {
        string_glob: {
          protocol: "s3",
          endpoint: "http://string-glob.com",
          buckets: "logs-*",
        },
        map_glob: {
          protocol: "s3",
          endpoint: "http://map-glob.com",
          buckets: {
            "logs-2025-*": {},
          },
        },
        direct: {
          protocol: "s3",
          endpoint: "http://direct.com",
          buckets: {
            "logs-2025-01": {},
          },
        },
      },
    },
    expectedBuckets: {
      "logs-2025-01": { backend_id: "direct", endpoint: "http://direct.com" },
      "logs-2025-02": {
        backend_id: "map_glob",
        endpoint: "http://map-glob.com",
      },
      "logs-2024-12": {
        backend_id: "string_glob",
        endpoint: "http://string-glob.com",
      },
    },
  },
  {
    id: "auth_basic",
    name: "auth config basic",
    input: {
      backends: {
        s3: {
          protocol: "s3",
          buckets: "*",
          auth: { accessKeysRefs: ["admin"] },
        },
      },
    },
  },
  {
    id: "auth_invalid_refs",
    name: "auth config invalid refs fails",
    input: {
      backends: {
        s3: {
          protocol: "s3",
          buckets: "*",
          auth: { accessKeysRefs: "admin" }, // Should be array
        },
      },
    },
    expectError: true,
  },
];

for (const tc of cases) {
  testEffect(`config/${tc.id}`, () =>
    Effect.gen(function* () {
      const program = Schema.decodeUnknown(GlobalConfig)(tc.input);

      if (tc.expectError) {
        const result = yield* Effect.either(program);
        assertEquals(
          Either.isLeft(result),
          true,
          `Expected decoding error for ${tc.name}`,
        );
      } else {
        const config = yield* program;

        if (tc.expectedBuckets) {
          for (const [id, expected] of Object.entries(tc.expectedBuckets)) {
            const actualOpt = lookupBucket(config, id);
            if (Option.isNone(actualOpt)) {
              return yield* Effect.fail(new Error(`Bucket ${id} not found`));
            }
            const actual = actualOpt.value;
            for (const [key, value] of Object.entries(expected)) {
              const actualValue =
                (actual as unknown as Record<string, unknown>)[key];
              yield* EffectAssert.strictEqual(
                actualValue,
                value,
                `Mismatch in ${id}.${key} for ${tc.name}`,
              );
            }
          }
        }
      }
    }));
}

testEffect("config/resolveAuthConfig/hierarchy", () =>
  Effect.gen(function* () {
    const config: GlobalConfig = {
      auth: { accessKeysRefs: ["global"] },
      backends: {
        s3: {
          protocol: "s3",
          buckets: {
            "bucket-override": {
              auth: { accessKeysRefs: ["bucket"] },
            },
            "bucket-no-override": {},
          },
          auth: { accessKeysRefs: ["backend"] },
        },
        other: {
          protocol: "s3",
          buckets: "*",
        },
      },
    };

    // Bucket override wins
    const auth1 = resolveAuthConfig(config, "bucket-override");
    yield* EffectAssert.deepStrictEqual(auth1?.accessKeysRefs, ["bucket"]);

    // Backend wins if no bucket override
    const auth2 = resolveAuthConfig(config, "bucket-no-override");
    yield* EffectAssert.deepStrictEqual(auth2?.accessKeysRefs, ["backend"]);

    // Global wins if no backend or bucket override
    const auth3 = resolveAuthConfig(config, "some-other-bucket");
    yield* EffectAssert.deepStrictEqual(auth3?.accessKeysRefs, ["global"]);
  }));

testEffect("config/parseConfig/env_vars", () =>
  Effect.gen(function* () {
    const env = {
      HERALD_DEFAULT_PROTOCOL: "s3",
      HERALD_DEFAULT_ENDPOINT: "http://localhost:9000",
      HERALD_MYBACKEND_PROTOCOL: "swift",
      HERALD_MYBACKEND_AUTH_URL: "http://swift.com",
    };
    const config = parseConfig({ backends: {} }, env);

    const defaultBackend = config.backends.default;
    yield* EffectAssert.strictEqual(defaultBackend.protocol, "s3");
    if (defaultBackend.protocol === "s3") {
      yield* EffectAssert.strictEqual(
        defaultBackend.endpoint,
        "http://localhost:9000",
      );
    }

    const myBackend = config.backends.mybackend;
    yield* EffectAssert.strictEqual(myBackend.protocol, "swift");
    if (myBackend.protocol === "swift") {
      yield* EffectAssert.strictEqual(
        myBackend.auth_url,
        "http://swift.com",
      );
    }
  }));

testEffect("config/parseConfig/auth_env_vars", () =>
  Effect.gen(function* () {
    const env = {
      HERALD_AUTH_ACCESS_KEYS_REFS: "global1,global2",
      HERALD_S3_PROTOCOL: "s3",
      HERALD_S3_AUTH_ACCESS_KEYS_REFS: "backend1",
    };
    const config = parseConfig({ backends: {} }, env);

    yield* EffectAssert.deepStrictEqual(config.auth?.accessKeysRefs, [
      "global1",
      "global2",
    ]);
    yield* EffectAssert.deepStrictEqual(
      config.backends.s3.auth?.accessKeysRefs,
      [
        "backend1",
      ],
    );
  }));

testEffect(
  "config/parseConfig/default_fallback",
  () =>
    Effect.gen(function* () {
      const config = parseConfig({ backends: {} }, {});
      yield* EffectAssert.strictEqual(config.backends.default.protocol, "s3");
      yield* EffectAssert.strictEqual(config.backends.default.buckets, "*");
    }),
);

interface ResolverTestCase {
  id: string;
  name: string;
  config: GlobalConfig;
  op: (
    resolver: BackendResolver,
  ) => Effect.Effect<
    unknown,
    unknown,
    HeraldConfig | S3ClientFactory | SwiftClient | Checksum | S3HeaderService
  >;
  expectedError?: string;
}

const resolverCases: ResolverTestCase[] = [
  {
    id: "resolve_by_bucket",
    name: "resolves backend by bucket name",
    config: {
      backends: {
        s3_main: {
          protocol: "s3",
          endpoint: "http://s3.amazonaws.com",
          region: "us-east-1",
          buckets: "*",
        },
      },
    },
    op: (resolver) =>
      Effect.gen(function* () {
        yield* resolver.getLayerForBucket(
          "any",
        );
        return "success";
      }),
  },
  {
    id: "resolve_missing_bucket",
    name: "fails when bucket matches no backend",
    config: {
      backends: {
        s3_main: {
          protocol: "s3",
          buckets: { "only-this": {} },
        },
      },
    },
    op: (resolver) =>
      Effect.gen(function* () {
        yield* resolver.getLayerForBucket(
          "not-found",
        );
        return "ok";
      }),
    expectedError: "No configuration found for bucket: not-found",
  },
  {
    id: "resolve_by_id",
    name: "resolves backend by backend ID",
    config: {
      backends: {
        s3_main: {
          protocol: "s3",
          endpoint: "http://s3.amazonaws.com",
          region: "us-east-1",
          buckets: "*",
        },
      },
    },
    op: (resolver) =>
      Effect.gen(function* () {
        yield* resolver.getLayerForBackend(
          "s3_main",
        );
        return "ok";
      }),
  },
  {
    id: "resolve_missing_id",
    name: "fails when backend ID is not found",
    config: {
      backends: {},
    },
    op: (resolver) =>
      Effect.gen(function* () {
        yield* resolver.getLayerForBackend(
          "missing",
        );
        return "ok";
      }),
    expectedError: "No configuration found for backend: missing",
  },
];

for (const tc of resolverCases) {
  testEffect(`resolver/${tc.id}`, () =>
    Effect.gen(function* () {
      const HeraldConfigLive = Layer.succeed(HeraldConfig, {
        raw: tc.config,
        lookupBucket: (name: string) => lookupBucket(tc.config, name),
        resolveAuth: () => Option.none(),
        resolveAuthForBackendId: () => Option.none(),
      });
      const program = Effect.gen(function* () {
        const resolver = yield* BackendResolver;
        return yield* tc.op(resolver);
      }).pipe(
        Effect.provide(BackendResolver.Default),
        Effect.provide(Checksum.Default),
        Effect.provide(S3HeaderService.Default),
        Effect.provide(S3ClientFactory.Default),
        Effect.provide(SwiftClient.Default),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(HeraldConfigLive),
        Effect.either,
      );

      const result = yield* program;

      if (tc.expectedError) {
        yield* EffectAssert.strictEqual(
          Either.isLeft(result),
          true,
          `Expected error for ${tc.name}`,
        );
        if (Either.isLeft(result)) {
          const error = result.left as Error;
          yield* EffectAssert.strictEqual(error.message, tc.expectedError);
        }
      } else {
        yield* EffectAssert.strictEqual(
          Either.isRight(result),
          true,
          `Expected success for ${tc.name}`,
        );
      }
    }));
}
