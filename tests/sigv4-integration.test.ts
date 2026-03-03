import { Effect, Layer, Option } from "effect";
import { FetchHttpClient, HttpApiBuilder, HttpServer } from "@effect/platform";
import { HttpHeraldLive } from "../src/Http.ts";
import { HeraldConfig } from "../src/Config/Layer.ts";
import { S3ClientFactory } from "../src/Backends/S3/Client.ts";
import { SwiftClient } from "../src/Backends/Swift/Client.ts";
import { S3XmlLive } from "../src/Services/S3Xml.ts";
import { Checksum } from "../src/Services/Checksum.ts";
import { S3HeaderService } from "../src/Services/S3HeaderService.ts";
import { BackendResolver } from "../src/Services/BackendResolver.ts";
import type { GlobalConfig } from "../src/Domain/Config.ts";
import { lookupBucket } from "../src/Domain/Config.ts";
import { EffectAssert, testEffect } from "./utils.ts";

const formatAmzDate = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const sec = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hour}${min}${sec}Z`;
};

const testCredentials = {
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
};

const testConfig: GlobalConfig = {
  backends: {
    default: {
      protocol: "s3",
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      credentials: {
        accessKeyId: "minioadmin",
        secretAccessKey: "minioadmin",
      },
      buckets: "*",
    },
  },
  auth: {
    accessKeysRefs: ["test"],
  },
};

const runRequest = (
  request: Request,
) =>
  Effect.gen(function* () {
    const HeraldConfigLive = Layer.succeed(HeraldConfig, {
      raw: testConfig,
      lookupBucket: (name: string) => lookupBucket(testConfig, name),
      resolveAuth: () => Option.some([testCredentials]),
      resolveAuthForBackendId: () => Option.some([testCredentials]),
    });

    const app = HttpHeraldLive.pipe(
      Layer.provide(BackendResolver.Default),
      Layer.provide(S3ClientFactory.Default),
      Layer.provide(SwiftClient.Default),
      Layer.provide(S3XmlLive),
      Layer.provide(Checksum.Default),
      Layer.provide(S3HeaderService.Default),
      Layer.provide(HeraldConfigLive),
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(HttpServer.layerContext),
    );

    return yield* Effect.tryPromise({
      try: async () => {
        const webHandler = HttpApiBuilder.toWebHandler(app);
        try {
          return await webHandler.handler(request);
        } finally {
          await webHandler.dispose();
        }
      },
      catch: (e) => new Error(String(e)),
    }).pipe(Effect.orDie);
  });

testEffect(
  "sigv4/integration/missing_authorization_rejected",
  () =>
    Effect.gen(function* () {
      const response = yield* runRequest(
        new Request("http://localhost/test-bucket", { method: "GET" }),
      );
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (e) => new Error(String(e)),
      }).pipe(Effect.orDie);

      yield* EffectAssert.strictEqual(response.status, 403);
      yield* EffectAssert.strictEqual(
        body.includes("<Code>AccessDenied</Code>"),
        true,
      );
    }),
);

testEffect(
  "sigv4/integration/malformed_authorization_rejected",
  () =>
    Effect.gen(function* () {
      const response = yield* runRequest(
        new Request("http://localhost/test-bucket", {
          method: "GET",
          headers: {
            authorization: "Bearer xyz",
          },
        }),
      );
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (e) => new Error(String(e)),
      }).pipe(Effect.orDie);

      yield* EffectAssert.strictEqual(response.status, 400);
      yield* EffectAssert.strictEqual(
        body.includes("<Code>InvalidArgument</Code>"),
        true,
      );
    }),
);

testEffect(
  "sigv4/integration/invalid_signature_rejected",
  () =>
    Effect.gen(function* () {
      const now = new Date();
      const amzDate = formatAmzDate(now);
      const scopeDate = amzDate.substring(0, 8);
      const response = yield* runRequest(
        new Request("http://localhost/test-bucket", {
          method: "GET",
          headers: {
            host: "localhost",
            "x-amz-date": amzDate,
            authorization:
              `AWS4-HMAC-SHA256 Credential=minioadmin/${scopeDate}/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=invalid`,
          },
        }),
      );
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (e) => new Error(String(e)),
      }).pipe(Effect.orDie);

      yield* EffectAssert.strictEqual(response.status, 403);
      yield* EffectAssert.strictEqual(
        body.includes("<Code>AccessDenied</Code>"),
        true,
      );
    }),
);

testEffect(
  "sigv4/integration/request_time_too_skewed_rejected",
  () =>
    Effect.gen(function* () {
      const response = yield* runRequest(
        new Request("http://localhost/test-bucket", {
          method: "GET",
          headers: {
            host: "localhost",
            "x-amz-date": "20000101T000000Z",
            authorization:
              "AWS4-HMAC-SHA256 Credential=minioadmin/20000101/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=invalid",
          },
        }),
      );
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (e) => new Error(String(e)),
      }).pipe(Effect.orDie);

      yield* EffectAssert.strictEqual(response.status, 403);
      yield* EffectAssert.strictEqual(
        body.includes("<Code>RequestTimeTooSkewed</Code>"),
        true,
      );
    }),
);
