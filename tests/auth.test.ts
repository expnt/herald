import { Effect } from "effect";
import { assertEquals, EffectAssert, testEffect } from "./utils.ts";
import {
  resolveAuthCredentials,
  verifyIncomingSigV4,
  verifyIncomingSigV4Detailed,
} from "../src/Services/Auth.ts";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256";
import type { HttpServerRequest } from "@effect/platform";
// deno-lint-ignore no-external-import
import { createHash, createHmac } from "node:crypto";

// Helper to format date as YYYYMMDDTHHMMSSZ
const formatAmzDate = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const sec = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hour}${min}${sec}Z`;
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

const createS3PresignedUrl = (options: {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly signedHeaders: Readonly<Record<string, string>>;
  readonly expiresIn: number;
  readonly signingDate: Date;
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  readonly region: string;
}): string => {
  const amzDate = formatAmzDate(options.signingDate);
  const scopeDate = amzDate.substring(0, 8);
  const credentialScope = `${scopeDate}/${options.region}/s3/aws4_request`;
  const signedHeaderNames = Object.keys(options.signedHeaders).map((name) =>
    name.toLowerCase()
  ).sort();
  const signedHeadersValue = signedHeaderNames.join(";");
  const baseQuery: Array<readonly [string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    [
      "X-Amz-Credential",
      `${options.credentials.accessKeyId}/${credentialScope}`,
    ],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(options.expiresIn)],
    ["X-Amz-SignedHeaders", signedHeadersValue],
  ];
  const canonicalQuery = [...baseQuery]
    .map(([key, value]) => [rfc3986Encode(key), rfc3986Encode(value)] as const)
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
      `${name}:${normalizeHeaderValue(options.signedHeaders[name] ?? "")}`
    ).join("\n")
  }\n`;
  const canonicalRequest = [
    options.method.toUpperCase(),
    options.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeadersValue,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const canonicalRequestHash = createHash("sha256").update(canonicalRequest)
    .digest("hex");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");
  const signingKey = deriveSigV4SigningKey(
    options.credentials.secretAccessKey,
    scopeDate,
    options.region,
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign)
    .digest(
      "hex",
    );
  const query = new URLSearchParams();
  for (const [key, value] of baseQuery) {
    query.append(key, value);
  }
  query.set("X-Amz-Signature", signature);
  return `http://${options.host}${options.path}?${query.toString()}`;
};

testEffect("auth/resolveAuthCredentials", () =>
  Effect.sync(() => {
    const env = {
      HERALD_AUTH_ADMIN_ACCESS_KEY_ID: "admin-id",
      HERALD_AUTH_ADMIN_SECRET_KEY: "admin-secret",
      HERALD_AUTH_USER_ACCESS_KEY_ID: "user-id",
      HERALD_AUTH_USER_SECRET_KEY: "user-secret",
    };

    const creds = resolveAuthCredentials(["admin", "user", "missing"], env);
    assertEquals(creds.length, 2);
    assertEquals(creds[0].accessKeyId, "admin-id");
    assertEquals(creds[1].accessKeyId, "user-id");
  }));

testEffect("auth/verifyIncomingSigV4/header", () =>
  Effect.gen(function* () {
    const credentials = [{
      accessKeyId: "test-id",
      secretAccessKey: "test-secret",
    }];
    const region = "us-east-1";

    const signer = new SignatureV4({
      credentials: credentials[0],
      region,
      service: "s3",
      sha256: Sha256,
    });

    const signingDate = new Date();
    const amzDate = formatAmzDate(signingDate);

    const _request = new Request("http://localhost/my-bucket/my-key", {
      method: "GET",
      headers: {
        "host": "localhost",
        "x-amz-date": amzDate,
      },
    });

    const signed = yield* Effect.promise(() =>
      signer.sign({
        method: "GET",
        protocol: "http:",
        hostname: "localhost",
        path: "/my-bucket/my-key",
        headers: {
          "host": "localhost",
          "x-amz-date": amzDate,
        },
      }, { signingDate })
    );

    const httpServerRequest = {
      method: "GET",
      url: "http://localhost/my-bucket/my-key",
      headers: signed.headers as Record<string, string>,
    } as unknown as HttpServerRequest.HttpServerRequest;

    const isValid = yield* verifyIncomingSigV4(
      httpServerRequest,
      credentials,
      region,
    );
    yield* EffectAssert.strictEqual(isValid, true);
  }));

testEffect(
  "auth/verifyIncomingSigV4/query_params",
  () =>
    Effect.gen(function* () {
      const credentials = [{
        accessKeyId: "test-id",
        secretAccessKey: "test-secret",
      }];
      const region = "us-east-1";

      const signingDate = new Date();
      const url = createS3PresignedUrl({
        method: "GET",
        host: "localhost",
        path: "/my-bucket/my-key",
        signedHeaders: {
          host: "localhost",
        },
        expiresIn: 300,
        signingDate,
        credentials: credentials[0],
        region,
      });

      const httpServerRequest = {
        method: "GET",
        url,
        headers: {
          host: "localhost",
        },
      } as unknown as HttpServerRequest.HttpServerRequest;

      const isValid = yield* verifyIncomingSigV4(
        httpServerRequest,
        credentials,
        region,
      );
      yield* EffectAssert.strictEqual(isValid, true);
    }),
);

testEffect(
  "auth/verifyIncomingSigV4/query_params/put_with_signed_acl",
  () =>
    Effect.gen(function* () {
      const credentials = [{
        accessKeyId: "test-id",
        secretAccessKey: "test-secret",
      }];
      const region = "us-east-1";

      const signingDate = new Date();
      const url = createS3PresignedUrl({
        method: "PUT",
        host: "localhost",
        path: "/my-bucket/my-key",
        signedHeaders: {
          host: "localhost",
          "x-amz-acl": "private",
        },
        expiresIn: 300,
        signingDate,
        credentials: credentials[0],
        region,
      });

      const result = yield* verifyIncomingSigV4Detailed(
        {
          method: "PUT",
          url,
          headers: {
            host: "localhost",
            "x-amz-acl": "private",
          },
        } as unknown as HttpServerRequest.HttpServerRequest,
        credentials,
        region,
      );

      if (!result.valid) {
        throw new Error(
          `Expected valid presigned ACL request, got ${result.failure}`,
        );
      }
      yield* EffectAssert.strictEqual(result.context.isPresigned, true);
      yield* EffectAssert.strictEqual(result.context.scopeService, "s3");
      yield* EffectAssert.strictEqual(
        result.context.signedHeaders.includes("x-amz-acl"),
        true,
      );
    }),
);

testEffect(
  "auth/verifyIncomingSigV4/streaming_sentinel_with_query_params",
  () =>
    Effect.gen(function* () {
      const credentials = [{
        accessKeyId: "test-id",
        secretAccessKey: "test-secret",
      }];
      const region = "us-east-1";
      const signingDate = new Date();
      const amzDate = formatAmzDate(signingDate);

      const signer = new SignatureV4({
        credentials: credentials[0],
        region,
        service: "s3",
        sha256: Sha256,
      });

      // Streaming sentinel payload hash (UNSIGNED-PAYLOAD) combined with
      // URL query params — the case the hand-rolled header signer must
      // canonicalize the query string for. Multipart UploadPart sends
      // `?partNumber=X&uploadId=Y` with a sentinel payload hash.
      const signed = yield* Effect.promise(() =>
        signer.sign({
          method: "PUT",
          protocol: "http:",
          hostname: "localhost",
          path: "/my-bucket/my-key",
          query: { partNumber: "1", uploadId: "ZTQzYWJjZA==" },
          headers: {
            host: "localhost",
            "x-amz-date": amzDate,
            "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
          },
        }, { signingDate })
      );

      const httpServerRequest = {
        method: "PUT",
        url:
          "http://localhost/my-bucket/my-key?partNumber=1&uploadId=ZTQzYWJjZA==",
        headers: signed.headers as Record<string, string>,
      } as unknown as HttpServerRequest.HttpServerRequest;

      const result = yield* verifyIncomingSigV4Detailed(
        httpServerRequest,
        credentials,
        region,
      );
      if (!result.valid) {
        throw new Error(
          `Expected streaming sentinel request with query params to verify, got ${result.failure}`,
        );
      }
      yield* EffectAssert.strictEqual(result.context.isPresigned, false);
      yield* EffectAssert.strictEqual(
        result.context.signedHeaders.includes("x-amz-content-sha256"),
        true,
      );
    }),
);

testEffect(
  "auth/verifyIncomingSigV4/streaming_sentinel_payload",
  () =>
    Effect.gen(function* () {
      const credentials = [{
        accessKeyId: "test-id",
        secretAccessKey: "test-secret",
      }];
      const region = "us-east-1";
      const signingDate = new Date();
      const amzDate = formatAmzDate(signingDate);

      const signer = new SignatureV4({
        credentials: credentials[0],
        region,
        service: "s3",
        sha256: Sha256,
      });

      // kopia's S3 client sends STREAMING-AWS4-HMAC-SHA256-PAYLOAD without
      // Content-Encoding: aws-chunked. Per SigV4 the canonical payload hash is
      // then the sentinel LITERAL, not sha256(body) — the verifier must carry
      // it through verbatim or the seed signature never matches.
      const signed = yield* Effect.promise(() =>
        signer.sign({
          method: "PUT",
          protocol: "http:",
          hostname: "localhost",
          path: "/my-bucket/my-key",
          headers: {
            host: "localhost",
            "x-amz-date": amzDate,
            "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
          },
          body: new TextEncoder().encode("kopia-blob"),
        }, { signingDate })
      );

      const httpServerRequest = {
        method: "PUT",
        url: "http://localhost/my-bucket/my-key",
        headers: signed.headers as Record<string, string>,
      } as unknown as HttpServerRequest.HttpServerRequest;

      const result = yield* verifyIncomingSigV4Detailed(
        httpServerRequest,
        credentials,
        region,
      );
      if (!result.valid) {
        throw new Error(
          `Expected STREAMING sentinel request to verify, got ${result.failure}`,
        );
      }
      yield* EffectAssert.strictEqual(result.context.isPresigned, false);
      yield* EffectAssert.strictEqual(
        result.context.signedHeaders.includes("x-amz-content-sha256"),
        true,
      );
    }),
);

testEffect(
  "auth/verifyIncomingSigV4/query_params/non_positive_expires_is_expired",
  () =>
    Effect.gen(function* () {
      const credentials = [{
        accessKeyId: "test-id",
        secretAccessKey: "test-secret",
      }];
      const region = "us-east-1";

      const signingDate = new Date(Date.now() - 60_000);
      const validUrl = createS3PresignedUrl({
        method: "PUT",
        host: "localhost",
        path: "/my-bucket/my-key",
        signedHeaders: {
          host: "localhost",
        },
        expiresIn: 300,
        signingDate,
        credentials: credentials[0],
        region,
      });
      const query = new URLSearchParams(new URL(validUrl).searchParams);
      query.set("X-Amz-Expires", "-1");
      const url = `http://localhost/my-bucket/my-key?${query.toString()}`;

      const result = yield* verifyIncomingSigV4Detailed(
        {
          method: "PUT",
          url,
          headers: {
            host: "localhost",
          },
        } as unknown as HttpServerRequest.HttpServerRequest,
        credentials,
        region,
      );

      yield* EffectAssert.deepStrictEqual(result, {
        valid: false,
        failure: "ExpiredPresign",
      });
    }),
);

testEffect(
  "auth/verifyIncomingSigV4/query_params/array_header_values",
  () =>
    Effect.gen(function* () {
      const credentials = [{
        accessKeyId: "test-id",
        secretAccessKey: "test-secret",
      }];
      const region = "us-east-1";

      const signingDate = new Date();
      const url = createS3PresignedUrl({
        method: "PUT",
        host: "localhost",
        path: "/my-bucket/my-key",
        signedHeaders: {
          host: "localhost",
          "x-amz-acl": "private",
        },
        expiresIn: 300,
        signingDate,
        credentials: credentials[0],
        region,
      });

      const result = yield* verifyIncomingSigV4Detailed(
        {
          method: "PUT",
          url,
          headers: {
            host: ["localhost"],
            "x-amz-acl": ["private"],
          },
        } as unknown as HttpServerRequest.HttpServerRequest,
        credentials,
        region,
      );

      if (!result.valid) {
        throw new Error(`Expected valid request, got ${result.failure}`);
      }
      yield* EffectAssert.strictEqual(result.context.isPresigned, true);
    }),
);

testEffect(
  "auth/verifyIncomingSigV4/invalid_signature",
  () =>
    Effect.gen(function* () {
      const credentials = [{
        accessKeyId: "test-id",
        secretAccessKey: "test-secret",
      }];
      const region = "us-east-1";

      const signingDate = new Date();
      const amzDate = formatAmzDate(signingDate);
      const dateStr = amzDate.substring(0, 8); // YYYYMMDD

      const httpServerRequest = {
        method: "GET",
        url: "http://localhost/my-bucket/my-key",
        headers: {
          "authorization":
            `AWS4-HMAC-SHA256 Credential=test-id/${dateStr}/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=invalid`,
          "x-amz-date": amzDate,
          "host": "localhost",
        },
      } as unknown as HttpServerRequest.HttpServerRequest;

      const isValid = yield* verifyIncomingSigV4(
        httpServerRequest,
        credentials,
        region,
      );
      yield* EffectAssert.strictEqual(isValid, false);
    }),
);

testEffect(
  "auth/verifyIncomingSigV4/multiple_keys",
  () =>
    Effect.gen(function* () {
      const credentials = [
        { accessKeyId: "other-id", secretAccessKey: "other-secret" },
        { accessKeyId: "test-id", secretAccessKey: "test-secret" },
      ];
      const region = "us-east-1";

      const signer = new SignatureV4({
        credentials: credentials[1], // Sign with second key
        region,
        service: "s3",
        sha256: Sha256,
      });

      const signingDate = new Date();
      const amzDate = formatAmzDate(signingDate);

      const signed = yield* Effect.promise(() =>
        signer.sign({
          method: "GET",
          protocol: "http:",
          hostname: "localhost",
          path: "/my-bucket/my-key",
          headers: {
            "host": "localhost",
            "x-amz-date": amzDate,
          },
        }, { signingDate })
      );

      const httpServerRequest = {
        method: "GET",
        url: "http://localhost/my-bucket/my-key",
        headers: signed.headers as Record<string, string>,
      } as unknown as HttpServerRequest.HttpServerRequest;

      const isValid = yield* verifyIncomingSigV4(
        httpServerRequest,
        credentials,
        region,
      );
      yield* EffectAssert.strictEqual(isValid, true);
    }),
);
