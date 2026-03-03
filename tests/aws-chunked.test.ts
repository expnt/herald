import { Chunk, Effect, Stream } from "effect";
import { assertEquals } from "@std/assert";
import { decodeAwsChunkedBodyStream } from "../src/Services/AwsChunked.ts";
import { S3HeaderService } from "../src/Services/S3HeaderService.ts";
import { testEffect } from "./utils.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (u: Uint8Array) => new TextDecoder().decode(u);

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
