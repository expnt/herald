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
// deno-lint-ignore no-external-import
import { createHash, createHmac } from "node:crypto";

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

const rfc3986Encode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const normalizeHeaderValue = (value: string): string =>
  value.trim().replace(/\s+/g, " ");

const deriveSigV4SigningKey = (
  secretAccessKey: string,
  scopeDate: string,
  region: string,
): Uint8Array => {
  const kDate = createHmac("sha256", `AWS4${secretAccessKey}`)
    .update(scopeDate)
    .digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update("s3").digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
};

const makePresignedUrl = (
  method: string,
  path: string,
  options?: {
    readonly expiresIn?: number;
    readonly headers?: Record<string, string>;
  },
) =>
  Effect.sync(() => {
    const signingDate = new Date();
    const amzDate = formatAmzDate(signingDate);
    const scopeDate = amzDate.substring(0, 8);
    const signedHeaders: Record<string, string> = {
      host: "localhost",
      ...(options?.headers ?? {}),
    };
    const signedHeaderNames = Object.keys(signedHeaders).map((name) =>
      name.toLowerCase()
    ).sort();
    const signedHeadersValue = signedHeaderNames.join(";");
    const credentialScope = `${scopeDate}/us-east-1/s3/aws4_request`;
    const baseQuery: Array<readonly [string, string]> = [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${testCredentials.accessKeyId}/${credentialScope}`],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(options?.expiresIn ?? 300)],
      ["X-Amz-SignedHeaders", signedHeadersValue],
    ];
    const canonicalQuery = [...baseQuery]
      .map(([key, value]) =>
        [rfc3986Encode(key), rfc3986Encode(value)] as const
      )
      .sort(([aKey, aValue], [bKey, bValue]) => {
        if (aKey < bKey) return -1;
        if (aKey > bKey) return 1;
        if (aValue < bValue) return -1;
        if (aValue > bValue) return 1;
        return 0;
      })
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    const canonicalHeaders = `${
      signedHeaderNames.map((name) =>
        `${name}:${normalizeHeaderValue(signedHeaders[name] ?? "")}`
      ).join("\n")
    }\n`;
    const canonicalRequest = [
      method.toUpperCase(),
      path,
      canonicalQuery,
      canonicalHeaders,
      signedHeadersValue,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const canonicalHash = createHash("sha256").update(canonicalRequest).digest(
      "hex",
    );
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      canonicalHash,
    ].join("\n");
    const signingKey = deriveSigV4SigningKey(
      testCredentials.secretAccessKey,
      scopeDate,
      "us-east-1",
    );
    const signature = createHmac("sha256", signingKey).update(stringToSign)
      .digest("hex");
    const query = new URLSearchParams();
    for (const [key, value] of baseQuery) {
      query.append(key, value);
    }
    query.set("X-Amz-Signature", signature);
    return `http://localhost${path}?${query.toString()}`;
  });

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

testEffect(
  "sigv4/integration/presigned_request_not_blocked_by_missing_authorization_header",
  () =>
    Effect.gen(function* () {
      const url = yield* makePresignedUrl("GET", "/test-bucket");
      const response = yield* runRequest(
        new Request(url, {
          method: "GET",
          headers: {
            host: "localhost",
          },
        }),
      );
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (e) => new Error(String(e)),
      }).pipe(Effect.orDie);

      // Auth passed if request progressed to backend (NoSuchBucket), not AccessDenied.
      yield* EffectAssert.strictEqual(response.status, 404);
      yield* EffectAssert.strictEqual(
        body.includes("<Code>NoSuchBucket</Code>"),
        true,
      );
    }),
);

testEffect(
  "sigv4/integration/presigned_negative_expires_rejected_as_expired",
  () =>
    Effect.gen(function* () {
      const validUrl = yield* makePresignedUrl("PUT", "/test-bucket/test-key");
      const parsed = new URL(validUrl);
      parsed.searchParams.set("X-Amz-Expires", "-1");

      const response = yield* runRequest(
        new Request(parsed.toString(), {
          method: "PUT",
          body: "abc",
          headers: {
            host: "localhost",
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
      yield* EffectAssert.strictEqual(
        body.includes("Request has expired"),
        true,
      );
    }),
);
