import { Effect } from "effect";
import { assertEquals, EffectAssert, testEffect } from "./utils.ts";
import {
  resolveAuthCredentials,
  verifyIncomingSigV4,
} from "../src/Services/Auth.ts";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256";
import type { HttpServerRequest } from "@effect/platform";

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

      const signer = new SignatureV4({
        credentials: credentials[0],
        region,
        service: "s3",
        sha256: Sha256,
      });

      const signingDate = new Date();
      const signed = yield* Effect.promise(() =>
        signer.sign({
          method: "GET",
          protocol: "http:",
          hostname: "localhost",
          path: "/my-bucket/my-key",
          headers: {
            "host": "localhost",
          },
        }, {
          signingDate,
          // @ts-ignore: signQuery might exist at runtime even if types mismatch
          signQuery: true,
        })
      );

      const queryStr = new URLSearchParams(
        signed.query as Record<string, string>,
      )
        .toString();
      const url = `http://localhost/my-bucket/my-key?${queryStr}`;

      const httpServerRequest = {
        method: "GET",
        url,
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
