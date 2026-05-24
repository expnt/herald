import { Chunk, Effect, Stream } from "effect";
import { assertEquals } from "@std/assert";
import { createHash, createHmac } from "node-crypto";
import {
  decodeAwsChunkedBodyStream,
  hasAwsChunkedContentEncoding,
} from "../src/Services/AwsChunked.ts";
import { S3HeaderService } from "../src/Services/S3HeaderService.ts";
import { testEffect } from "./utils.ts";
import type { SigV4VerifiedContext } from "../src/Services/Auth.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (u: Uint8Array) => new TextDecoder().decode(u);
const EMPTY_SHA256_HEX =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const deriveSigningKey = (
  secretAccessKey: string,
  scopeDate: string,
  scopeRegion: string,
  scopeService: string,
): Uint8Array<ArrayBufferLike> => {
  const kDate = createHmac("sha256", `AWS4${secretAccessKey}`)
    .update(scopeDate, "utf8").digest();
  const kRegion = createHmac("sha256", kDate).update(scopeRegion, "utf8")
    .digest();
  const kService = createHmac("sha256", kRegion).update(scopeService, "utf8")
    .digest();
  return createHmac("sha256", kService).update("aws4_request", "utf8").digest();
};

const buildSignedPayload = (
  plaintext: string,
  context: SigV4VerifiedContext,
): string => {
  const signingKey = deriveSigningKey(
    context.secretAccessKey,
    context.scopeDate,
    context.scopeRegion,
    context.scopeService,
  );
  const scope =
    `${context.scopeDate}/${context.scopeRegion}/${context.scopeService}/aws4_request`;
  const chunkHash = createHash("sha256").update(plaintext, "utf8").digest(
    "hex",
  );
  const chunkStringToSign =
    `AWS4-HMAC-SHA256-PAYLOAD\n${context.amzDate}\n${scope}\n${context.initialSignature}\n${EMPTY_SHA256_HEX}\n${chunkHash}`;
  const chunkSignature = createHmac("sha256", signingKey).update(
    chunkStringToSign,
    "utf8",
  ).digest("hex");

  const finalStringToSign =
    `AWS4-HMAC-SHA256-PAYLOAD\n${context.amzDate}\n${scope}\n${chunkSignature}\n${EMPTY_SHA256_HEX}\n${EMPTY_SHA256_HEX}`;
  const finalSignature = createHmac("sha256", signingKey).update(
    finalStringToSign,
    "utf8",
  ).digest("hex");

  const sizeHex = plaintext.length.toString(16);
  return `${sizeHex};chunk-signature=${chunkSignature}\r\n${plaintext}\r\n0;chunk-signature=${finalSignature}\r\n\r\n`;
};

const collectBytes = (chunks: Chunk.Chunk<Uint8Array>): Uint8Array => {
  const total = Chunk.reduce(chunks, 0, (acc, c) => acc + c.length);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

testEffect("aws-chunked/decode/basic", () =>
  Effect.gen(function* () {
    const framed = bytes(
      "b;chunk-signature=abc\r\nhello world\r\n0;chunk-signature=def\r\n\r\n",
    );
    const decoded = decodeAwsChunkedBodyStream(Stream.succeed(framed));
    const chunks = yield* Stream.runCollect(decoded);
    assertEquals(text(collectBytes(chunks)), "hello world");
  }));

testEffect(
  "aws-chunked/decode/split-boundaries",
  () =>
    Effect.gen(function* () {
      const c1 = bytes("5;chunk-signature=111\r\nhello\r\n");
      const c2 = bytes("6;chunk-signature=222\r\n world\r\n");
      const c3 = bytes("0;chunk-signature=333\r\n");
      const c4 = bytes("\r\n");
      const decoded = decodeAwsChunkedBodyStream(
        Stream.fromIterable([c1, c2, c3, c4]),
      );
      const chunks = yield* Stream.runCollect(decoded);
      assertEquals(text(collectBytes(chunks)), "hello world");
    }),
);

testEffect("aws-chunked/decode/invalid-framing", () =>
  Effect.gen(function* () {
    const invalid = bytes(
      "5;chunk-signature=abc\r\nhelloX0;chunk-signature=def\r\n\r\n",
    );
    const exit = yield* Stream.runCollect(
      decodeAwsChunkedBodyStream(Stream.succeed(invalid)),
    ).pipe(Effect.exit);
    if (exit._tag !== "Failure") {
      throw new Error("Expected aws-chunked decoding to fail");
    }
    const failure = exit.cause;
    const pretty = String(failure);
    if (!pretty.includes("InvalidRequest")) {
      throw new Error(`Expected InvalidRequest failure, got: ${pretty}`);
    }
  }));

testEffect(
  "aws-chunked/decoded-content-length/header-parse",
  () =>
    Effect.gen(function* () {
      const headerService = yield* S3HeaderService;
      const parsed = headerService.fromRequestHeaders({
        "content-encoding": "aws-chunked",
        "content-length": "999",
        "x-amz-decoded-content-length": "11",
      });
      assertEquals(parsed.s3Params.contentLength, 11);
    }).pipe(Effect.provide(S3HeaderService.Default)),
);

testEffect("aws-chunked/detect/by-content-encoding", () =>
  Effect.sync(() => {
    assertEquals(
      hasAwsChunkedContentEncoding({
        "content-encoding": "aws-chunked",
      }),
      false,
    );
  }));

testEffect(
  "aws-chunked/detect/by-content-encoding-with-decoded-length",
  () =>
    Effect.sync(() => {
      assertEquals(
        hasAwsChunkedContentEncoding({
          "content-encoding": "aws-chunked",
          "x-amz-decoded-content-length": "11",
        }),
        true,
      );
    }),
);

testEffect(
  "aws-chunked/detect/by-streaming-sha256-header",
  () =>
    Effect.sync(() => {
      assertEquals(
        hasAwsChunkedContentEncoding({
          "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
        }),
        true,
      );
    }),
);

testEffect(
  "aws-chunked/decoded-content-length/streaming-sha256-header-parse",
  () =>
    Effect.gen(function* () {
      const headerService = yield* S3HeaderService;
      const parsed = headerService.fromRequestHeaders({
        "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
        "content-length": "999",
        "x-amz-decoded-content-length": "11",
      });
      assertEquals(parsed.s3Params.contentLength, 11);
    }).pipe(Effect.provide(S3HeaderService.Default)),
);

testEffect(
  "aws-chunked/verify/streaming-signed-payload",
  () =>
    Effect.gen(function* () {
      const context: SigV4VerifiedContext = {
        accessKeyId: "test",
        secretAccessKey: "test-secret",
        scopeDate: "20260303",
        scopeRegion: "us-east-1",
        scopeService: "s3",
        amzDate: "20260303T000000Z",
        initialSignature:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        signedHeaders: ["host", "x-amz-date"],
        isPresigned: false,
      };
      const framed = buildSignedPayload("hello world", context);
      const decoded = decodeAwsChunkedBodyStream(
        Stream.succeed(bytes(framed)),
        {
          headers: {
            "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
            "x-amz-decoded-content-length": "11",
          },
          sigV4Context: context,
        },
      );
      const chunks = yield* Stream.runCollect(decoded);
      assertEquals(text(collectBytes(chunks)), "hello world");
    }),
);

testEffect(
  "aws-chunked/verify/streaming-signed-payload/bad-signature",
  () =>
    Effect.gen(function* () {
      const context: SigV4VerifiedContext = {
        accessKeyId: "test",
        secretAccessKey: "test-secret",
        scopeDate: "20260303",
        scopeRegion: "us-east-1",
        scopeService: "s3",
        amzDate: "20260303T000000Z",
        initialSignature:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        signedHeaders: ["host", "x-amz-date"],
        isPresigned: false,
      };
      const framed =
        "b;chunk-signature=abc\r\nhello world\r\n0;chunk-signature=def\r\n\r\n";
      const exit = yield* Stream.runCollect(
        decodeAwsChunkedBodyStream(
          Stream.succeed(bytes(framed)),
          {
            headers: {
              "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
              "x-amz-decoded-content-length": "11",
            },
            sigV4Context: context,
          },
        ),
      ).pipe(Effect.exit);
      if (exit._tag !== "Failure") {
        throw new Error("Expected bad signature to fail");
      }
      const pretty = String(exit.cause);
      if (!pretty.includes("AccessDenied")) {
        throw new Error(
          `Expected AccessDenied for bad signature, got: ${pretty}`,
        );
      }
    }),
);
