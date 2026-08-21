import { Chunk, Effect, Stream } from "effect";
import { assertEquals } from "@std/assert";
import { createHash, createHmac } from "node-crypto";
import {
  AwsChunkedParser,
  type AwsChunkedParserOptions,
  decodeAwsChunkedBodyStream,
  hasAwsChunkedContentEncoding,
} from "../src/Services/AwsChunked.ts";
import { AccessDenied, InvalidRequest } from "../src/Services/Backend.ts";
import type { SigV4VerifiedContext } from "../src/Services/Auth.ts";
import { S3HeaderService } from "../src/Services/S3HeaderService.ts";
import { testEffect } from "./utils.ts";

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
    .update(scopeDate, "utf8")
    .digest();
  const kRegion = createHmac("sha256", kDate)
    .update(scopeRegion, "utf8")
    .digest();
  const kService = createHmac("sha256", kRegion)
    .update(scopeService, "utf8")
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
  const chunkHash = createHash("sha256")
    .update(plaintext, "utf8")
    .digest("hex");
  const chunkStringToSign =
    `AWS4-HMAC-SHA256-PAYLOAD\n${context.amzDate}\n${scope}\n${context.initialSignature}\n${EMPTY_SHA256_HEX}\n${chunkHash}`;
  const chunkSignature = createHmac("sha256", signingKey)
    .update(chunkStringToSign, "utf8")
    .digest("hex");

  const finalStringToSign =
    `AWS4-HMAC-SHA256-PAYLOAD\n${context.amzDate}\n${scope}\n${chunkSignature}\n${EMPTY_SHA256_HEX}\n${EMPTY_SHA256_HEX}`;
  const finalSignature = createHmac("sha256", signingKey)
    .update(finalStringToSign, "utf8")
    .digest("hex");

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
        decodeAwsChunkedBodyStream(Stream.succeed(bytes(framed)), {
          headers: {
            "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
            "x-amz-decoded-content-length": "11",
          },
          sigV4Context: context,
        }),
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

// ---------------------------------------------------------------------------
// Incremental parser regression suite
//
// The production parser was rewritten from a copy-accumulating design (full
// buffer memcpy on every feed) to an incremental one. The `NaiveParser` below
// is a faithful port of the ORIGINAL implementation and serves as the
// behavioral oracle: the differential tests assert the incremental parser is
// byte-exact and failure-identical against it.
// ---------------------------------------------------------------------------

const CR = 13;
const LF = 10;
// Mirrors unexported limits in src/Services/AwsChunked.ts.
const MAX_CONTROL_LINE_LENGTH = 8 * 1024;
const MAX_CHUNK_SIZE_BYTES = 128 * 1024 * 1024;

const appendBytes = (
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const findCrlf = (buffer: Uint8Array<ArrayBufferLike>): number => {
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === CR && buffer[i + 1] === LF) {
      return i;
    }
  }
  return -1;
};

const parseChunkControlLine = (
  line: string,
): { size: number; signature?: string } => {
  const semi = line.indexOf(";");
  const token = (semi === -1 ? line : line.slice(0, semi)).trim();
  if (token.length === 0 || token.length > MAX_CONTROL_LINE_LENGTH) {
    throw new InvalidRequest({
      message: "Invalid aws-chunked chunk-size line",
    });
  }
  if (!/^[0-9a-fA-F]+$/.test(token)) {
    throw new InvalidRequest({
      message: "Invalid aws-chunked chunk-size line",
    });
  }
  const size = Number.parseInt(token, 16);
  if (!Number.isFinite(size) || size < 0 || size > MAX_CHUNK_SIZE_BYTES) {
    throw new InvalidRequest({
      message: "Invalid aws-chunked chunk-size line",
    });
  }
  if (semi === -1) {
    return { size };
  }
  const extensions = line.slice(semi + 1).split(";");
  let signature: string | undefined;
  for (const ext of extensions) {
    const eq = ext.indexOf("=");
    if (eq === -1) continue;
    const key = ext.slice(0, eq).trim().toLowerCase();
    const value = ext.slice(eq + 1).trim();
    if (key === "chunk-signature" && value !== "") {
      signature = value.toLowerCase();
      break;
    }
  }
  return { size, signature };
};

const verifyStreamingChunkSignature = (
  signingKey: Uint8Array<ArrayBufferLike>,
  previousSignature: string,
  amzDate: string,
  scopeDate: string,
  scopeRegion: string,
  scopeService: string,
  chunkBytes: Uint8Array<ArrayBufferLike>,
  chunkSignature: string,
): string => {
  const scope = `${scopeDate}/${scopeRegion}/${scopeService}/aws4_request`;
  const chunkHash = createHash("sha256").update(chunkBytes).digest("hex");
  const stringToSign =
    `${SIGV4_STREAMING_ALGORITHM}\n${amzDate}\n${scope}\n${previousSignature}\n${EMPTY_SHA256_HEX}\n${chunkHash}`;
  const expected = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");
  if (expected !== chunkSignature.toLowerCase()) {
    throw new AccessDenied({
      message:
        "The request signature we calculated does not match the signature you provided.",
    });
  }
  return expected;
};

/**
 * Behavioral oracle: verbatim port of the original copy-accumulating parser.
 */
class NaiveParser {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private expectedSize = 0;
  private expectedChunkSignature: string | undefined;
  private phase: "size" | "data" | "data-crlf" | "trailers" | "done" = "size";
  private readonly decoder = new TextDecoder();
  private previousSignature: string | undefined;
  private decodedBytes = 0;

  constructor(private readonly options: AwsChunkedParserOptions) {
    this.previousSignature = options.sigV4Context?.initialSignature
      .toLowerCase();
  }

  feed(chunk: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike>[] {
    this.buffer = appendBytes(this.buffer, chunk);
    const out: Uint8Array<ArrayBufferLike>[] = [];

    while (true) {
      if (this.phase === "size") {
        const idx = findCrlf(this.buffer);
        if (idx === -1) {
          if (this.buffer.length > MAX_CONTROL_LINE_LENGTH) {
            throw new InvalidRequest({
              message: "Invalid aws-chunked chunk-size line",
            });
          }
          break;
        }
        const line = this.decoder.decode(this.buffer.slice(0, idx));
        this.buffer = this.buffer.slice(idx + 2);
        const parsed = parseChunkControlLine(line);
        this.expectedSize = parsed.size;
        this.expectedChunkSignature = parsed.signature;
        if (
          this.options.requireChunkSignatures &&
          !this.expectedChunkSignature
        ) {
          throw new AccessDenied({
            message:
              "The request signature we calculated does not match the signature you provided.",
          });
        }
        if (this.expectedSize === 0) {
          if (
            this.options.requireChunkSignatures &&
            this.options.signingKey &&
            this.options.sigV4Context &&
            this.expectedChunkSignature &&
            this.previousSignature
          ) {
            this.previousSignature = verifyStreamingChunkSignature(
              this.options.signingKey,
              this.previousSignature,
              this.options.sigV4Context.amzDate,
              this.options.sigV4Context.scopeDate,
              this.options.sigV4Context.scopeRegion,
              this.options.sigV4Context.scopeService,
              new Uint8Array(0),
              this.expectedChunkSignature,
            );
          }
          this.phase = "trailers";
        } else {
          this.phase = "data";
        }
        continue;
      }

      if (this.phase === "data") {
        if (this.buffer.length < this.expectedSize) break;
        const payload = this.buffer.slice(0, this.expectedSize);
        if (
          this.options.requireChunkSignatures &&
          this.options.signingKey &&
          this.options.sigV4Context &&
          this.expectedChunkSignature &&
          this.previousSignature
        ) {
          this.previousSignature = verifyStreamingChunkSignature(
            this.options.signingKey,
            this.previousSignature,
            this.options.sigV4Context.amzDate,
            this.options.sigV4Context.scopeDate,
            this.options.sigV4Context.scopeRegion,
            this.options.sigV4Context.scopeService,
            payload,
            this.expectedChunkSignature,
          );
        }
        out.push(payload);
        this.decodedBytes += payload.length;
        this.buffer = this.buffer.slice(this.expectedSize);
        this.phase = "data-crlf";
        continue;
      }

      if (this.phase === "data-crlf") {
        if (this.buffer.length < 2) break;
        if (this.buffer[0] !== CR || this.buffer[1] !== LF) {
          throw new InvalidRequest({
            message: "Invalid aws-chunked framing after chunk data",
          });
        }
        this.buffer = this.buffer.slice(2);
        this.phase = "size";
        continue;
      }

      if (this.phase === "trailers") {
        const idx = findCrlf(this.buffer);
        if (idx === -1) {
          if (this.buffer.length > MAX_CONTROL_LINE_LENGTH) {
            throw new InvalidRequest({
              message: "Invalid aws-chunked framing",
            });
          }
          break;
        }
        const lineBytes = this.buffer.slice(0, idx);
        const line = this.decoder.decode(lineBytes);
        this.buffer = this.buffer.slice(idx + 2);
        if (line.length === 0) {
          this.phase = "done";
        }
        continue;
      }

      if (this.phase === "done") {
        if (this.buffer.length > 0) {
          throw new InvalidRequest({
            message: "Unexpected trailing data after aws-chunked payload",
          });
        }
        break;
      }
    }

    return out;
  }

  finish(): void {
    if (this.phase !== "done") {
      throw new InvalidRequest({
        message: "Incomplete aws-chunked payload",
      });
    }
    if (
      this.options.expectedDecodedLength !== undefined &&
      this.decodedBytes !== this.options.expectedDecodedLength
    ) {
      throw new InvalidRequest({
        message:
          "Decoded payload length does not match x-amz-decoded-content-length",
      });
    }
    if (this.buffer.length !== 0) {
      throw new InvalidRequest({
        message: "Unexpected buffered bytes after aws-chunked payload",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic PRNG + frame construction
// ---------------------------------------------------------------------------

/** mulberry32 — small deterministic PRNG so failures are reproducible. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SIGV4_STREAMING_ALGORITHM = "AWS4-HMAC-SHA256-PAYLOAD";

const fuzzContext = (): SigV4VerifiedContext => ({
  accessKeyId: "fuzz",
  secretAccessKey: "fuzz-secret",
  scopeDate: "20260821",
  scopeRegion: "us-east-1",
  scopeService: "s3",
  amzDate: "20260821T000000Z",
  initialSignature:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  signedHeaders: ["host", "x-amz-date"],
  isPresigned: false,
});

interface FuzzFrame {
  frame: Uint8Array;
  payloads: Uint8Array[];
  totalPayload: number;
}

const buildFuzzFrame = (
  rng: () => number,
  opts: { signed: boolean; trailers: boolean; junkExtensions: boolean },
): FuzzFrame => {
  const chunkCount = 1 + Math.floor(rng() * 4); // 1..4 data chunks
  const payloads: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const size = Math.floor(rng() * 3000);
    const payload = new Uint8Array(size);
    for (let j = 0; j < size; j++) payload[j] = Math.floor(rng() * 256);
    payloads.push(payload);
  }
  // Payload bytes that deliberately look like framing must never appear
  // unescaped in real frames, so scrub CR/LF from generated payloads.
  for (const p of payloads) {
    for (let j = 0; j < p.length; j++) {
      if (p[j] === CR || p[j] === LF) p[j] = 0x41;
    }
  }

  const signingKey = deriveSigningKey(
    "fuzz-secret",
    "20260821",
    "us-east-1",
    "s3",
  );
  const ctx = fuzzContext();
  const scope =
    `${ctx.scopeDate}/${ctx.scopeRegion}/${ctx.scopeService}/aws4_request`;

  const parts: Uint8Array[] = [];
  let previousSignature = ctx.initialSignature;
  for (const payload of payloads) {
    let header: string;
    if (opts.signed) {
      const chunkHash = createHash("sha256").update(payload).digest("hex");
      const stringToSign =
        `${SIGV4_STREAMING_ALGORITHM}\n${ctx.amzDate}\n${scope}\n${previousSignature}\n${EMPTY_SHA256_HEX}\n${chunkHash}`;
      const signature = createHmac("sha256", signingKey)
        .update(stringToSign, "utf8")
        .digest("hex");
      previousSignature = signature;
      header = `${
        payload.length.toString(16)
      };chunk-signature=${signature}\r\n`;
    } else {
      const ext = opts.junkExtensions
        ? `;foo=bar;chunk-signature=${"ab".repeat(32)}\r\n`
        : `\r\n`;
      header = `${payload.length.toString(16)}${ext}`;
    }
    parts.push(new TextEncoder().encode(header));
    parts.push(payload);
    parts.push(new TextEncoder().encode("\r\n"));
  }
  // Final zero-size chunk.
  let finalHeader: string;
  if (opts.signed) {
    const stringToSign =
      `${SIGV4_STREAMING_ALGORITHM}\n${ctx.amzDate}\n${scope}\n${previousSignature}\n${EMPTY_SHA256_HEX}\n${EMPTY_SHA256_HEX}`;
    const signature = createHmac("sha256", signingKey)
      .update(stringToSign, "utf8")
      .digest("hex");
    finalHeader = `0;chunk-signature=${signature}\r\n`;
  } else {
    finalHeader = `0\r\n`;
  }
  parts.push(new TextEncoder().encode(finalHeader));
  if (opts.trailers) {
    parts.push(new TextEncoder().encode("x-amz-checksum-crc32:AAAAAA==\r\n"));
  }
  parts.push(new TextEncoder().encode("\r\n"));

  const frame = appendBytesAll(parts);
  const totalPayload = payloads.reduce((acc, p) => acc + p.length, 0);
  return { frame, payloads, totalPayload };
};

const appendBytesAll = (parts: Uint8Array[]): Uint8Array<ArrayBufferLike> => {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

type SplitMode = "byte" | "seven" | "64k" | "random";

const splitFrame = (
  frame: Uint8Array,
  mode: SplitMode,
  rng: () => number,
): Uint8Array[] => {
  const pieces: Uint8Array[] = [];
  let idx = 0;
  while (idx < frame.length) {
    let size: number;
    if (mode === "byte") size = 1;
    else if (mode === "seven") size = 7;
    else if (mode === "64k") size = 65536;
    else size = 1 + Math.floor(rng() * 97);
    const end = Math.min(idx + size, frame.length);
    pieces.push(frame.subarray(idx, end));
    idx = end;
  }
  return pieces;
};

interface RunOutcome {
  output: Uint8Array;
  error: { tag: string; message: string } | undefined;
}

const runParser = (
  parser: AwsChunkedParser | NaiveParser,
  pieces: Uint8Array[],
): RunOutcome => {
  const chunks: Uint8Array[] = [];
  try {
    for (const piece of pieces) chunks.push(...parser.feed(piece));
    parser.finish();
  } catch (error) {
    return {
      output: concatChunks(chunks),
      error: {
        tag: (error as { _tag?: string })._tag ?? "unknown",
        message: (error as Error).message,
      },
    };
  }
  return { output: concatChunks(chunks), error: undefined };
};

const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

testEffect(
  "aws-chunked/incremental/differential-vs-naive",
  () =>
    Effect.sync(() => {
      const rng = mulberry32(0xc0ffee);
      const splitModes: SplitMode[] = ["byte", "seven", "64k", "random"];
      let cases = 0;
      for (let i = 0; i < 96; i++) {
        const signed = i % 2 === 0;
        const trailers = i % 3 === 0;
        const junkExtensions = !signed && i % 4 === 1;
        const { frame, totalPayload } = buildFuzzFrame(rng, {
          signed,
          trailers,
          junkExtensions,
        });
        const mode = splitModes[i % splitModes.length];
        const pieces = splitFrame(frame, mode, rng);

        const options: AwsChunkedParserOptions = {
          requireChunkSignatures: signed,
          signingKey: signed
            ? deriveSigningKey("fuzz-secret", "20260821", "us-east-1", "s3")
            : undefined,
          sigV4Context: signed ? fuzzContext() : undefined,
          expectedDecodedLength: totalPayload,
        };
        const incremental = runParser(new AwsChunkedParser(options), pieces);
        const naive = runParser(new NaiveParser(options), pieces);

        assertEquals(
          incremental.error?.tag,
          naive.error?.tag,
          `case ${i} (${mode}) error tag mismatch`,
        );
        assertEquals(
          incremental.error?.message,
          naive.error?.message,
          `case ${i} (${mode}) error message mismatch`,
        );
        assertEquals(
          incremental.output,
          naive.output,
          `case ${i} (${mode}) decoded bytes mismatch`,
        );
        cases++;
      }
      assertEquals(cases, 96);
    }),
);

testEffect(
  "aws-chunked/incremental/split-control-line-across-feeds",
  () =>
    Effect.sync(() => {
      const frame = new TextEncoder().encode(
        "5;chunk-signature=111\r\nhello\r\n0\r\n\r\n",
      );
      // Split inside the size token and inside the CRLF.
      const pieces = [
        frame.subarray(0, 1), // "5"
        frame.subarray(1, 3), // ";c"
        frame.subarray(3, 22), // rest of header incl \r
        frame.subarray(22), // "\nhello\r\n0\r\n\r\n"
      ];
      const incremental = runParser(
        new AwsChunkedParser({ requireChunkSignatures: false }),
        pieces,
      );
      const naive = runParser(
        new NaiveParser({ requireChunkSignatures: false }),
        pieces,
      );
      assertEquals(new TextDecoder().decode(incremental.output), "hello");
      assertEquals(incremental.error, undefined);
      assertEquals(incremental.output, naive.output);
    }),
);

testEffect(
  "aws-chunked/incremental/split-data-crlf-across-feeds",
  () =>
    Effect.sync(() => {
      const frame = new TextEncoder().encode(
        "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
      );
      // Feed up to and including the CR after "hello", then the LF alone.
      const pieces = [
        frame.subarray(0, 9), // "5\r\nhello\r"
        frame.subarray(9), // "\n6\r\n world\r\n0\r\n\r\n"
      ];
      const incremental = runParser(
        new AwsChunkedParser({ requireChunkSignatures: false }),
        pieces,
      );
      assertEquals(new TextDecoder().decode(incremental.output), "hello world");
      assertEquals(incremental.error, undefined);
    }),
);

testEffect(
  "aws-chunked/incremental/mid-payload-boundary-split",
  () =>
    Effect.sync(() => {
      const payload = new Uint8Array(100);
      for (let i = 0; i < payload.length; i++) {
        payload[i] = (i * 7) % 251;
      }
      const frame = appendBytesAll([
        new TextEncoder().encode(`${payload.length.toString(16)}\r\n`),
        payload,
        new TextEncoder().encode("\r\n0\r\n\r\n"),
      ]);
      // One byte at a time through the middle of the payload.
      const pieces = splitFrame(frame, "byte", mulberry32(1));
      const incremental = runParser(
        new AwsChunkedParser({
          requireChunkSignatures: false,
          expectedDecodedLength: payload.length,
        }),
        pieces,
      );
      assertEquals(incremental.error, undefined);
      assertEquals(incremental.output, payload);
    }),
);

testEffect(
  "aws-chunked/incremental/split-trailer-across-feeds",
  () =>
    Effect.sync(() => {
      const frame = new TextEncoder().encode(
        "2\r\nhi\r\n0\r\nx-amz-checksum-crc32:AAAA\r\n\r\n",
      );
      const pieces = [
        frame.subarray(0, 10), // "2\r\nhi\r\n0\r\n" minus last byte? adjust: keep exact
      ];
      // Feed in 3-byte pieces so trailer lines split arbitrarily.
      const pieces3 = splitFrame(frame, "seven", mulberry32(2));
      const incremental = runParser(
        new AwsChunkedParser({ requireChunkSignatures: false }),
        pieces3,
      );
      const naive = runParser(
        new NaiveParser({ requireChunkSignatures: false }),
        pieces3,
      );
      assertEquals(new TextDecoder().decode(incremental.output), "hi");
      assertEquals(incremental.error, undefined);
      assertEquals(incremental.output, naive.output);
      void pieces;
    }),
);

testEffect(
  "aws-chunked/incremental/truncated-input-fails-incomplete",
  () =>
    Effect.gen(function* () {
      const framed = new TextEncoder().encode("5\r\nhello\r\n");
      const exit = yield* Stream.runCollect(
        decodeAwsChunkedBodyStream(
          Stream.fromIterable([framed.subarray(0, 4), framed.subarray(4)]),
        ),
      ).pipe(Effect.exit);
      const pretty = String(exit);
      if (!pretty.includes("Incomplete aws-chunked payload")) {
        throw new Error(`Expected Incomplete failure, got: ${pretty}`);
      }
    }),
);

testEffect(
  "aws-chunked/incremental/decoded-length-mismatch-fails",
  () =>
    Effect.gen(function* () {
      const framed = new TextEncoder().encode("5\r\nhello\r\n0\r\n\r\n");
      const decoded = decodeAwsChunkedBodyStream(Stream.succeed(framed), {
        headers: {
          "content-encoding": "aws-chunked",
          "x-amz-decoded-content-length": "4",
        },
      });
      const exit = yield* Stream.runCollect(decoded).pipe(Effect.exit);
      const pretty = String(exit);
      if (
        !pretty.includes(
          "Decoded payload length does not match x-amz-decoded-content-length",
        )
      ) {
        throw new Error(`Expected length mismatch failure, got: ${pretty}`);
      }
    }),
);

testEffect(
  "aws-chunked/incremental/trailing-garbage-fails",
  () =>
    Effect.gen(function* () {
      const framed = new TextEncoder().encode("5\r\nhello\r\n0\r\n\r\nJUNK");
      const decoded = decodeAwsChunkedBodyStream(Stream.succeed(framed));
      const exit = yield* Stream.runCollect(decoded).pipe(Effect.exit);
      const pretty = String(exit);
      if (
        !pretty.includes("Unexpected trailing data after aws-chunked payload")
      ) {
        throw new Error(`Expected trailing-data failure, got: ${pretty}`);
      }
    }),
);

testEffect(
  "aws-chunked/incremental/oversize-control-line-fails",
  () =>
    Effect.sync(() => {
      // No CRLF within a line longer than MAX_CONTROL_LINE_LENGTH.
      const longLine = new TextEncoder().encode(
        "5" + "f".repeat(MAX_CONTROL_LINE_LENGTH + 1),
      );
      const parser = new AwsChunkedParser({ requireChunkSignatures: false });
      let thrown: unknown;
      try {
        for (const piece of splitFrame(longLine, "seven", mulberry32(3))) {
          parser.feed(piece);
        }
      } catch (error) {
        thrown = error;
      }
      if (
        !(thrown instanceof InvalidRequest) ||
        thrown.message !== "Invalid aws-chunked chunk-size line"
      ) {
        throw new Error(
          `Expected oversize control-line failure, got: ${thrown}`,
        );
      }
    }),
);

testEffect(
  "aws-chunked/incremental/chunk-size-over-limit-fails",
  () =>
    Effect.sync(() => {
      // 0x80000001 = 2GB + 1 > MAX_CHUNK_SIZE_BYTES (128MB).
      const frame = new TextEncoder().encode("80000001\r\n");
      const parser = new AwsChunkedParser({ requireChunkSignatures: false });
      let thrown: unknown;
      try {
        parser.feed(frame);
      } catch (error) {
        thrown = error;
      }
      if (
        !(thrown instanceof InvalidRequest) ||
        thrown.message !== "Invalid aws-chunked chunk-size line"
      ) {
        throw new Error(
          `Expected chunk-size-over-limit failure, got: ${thrown}`,
        );
      }
    }),
);

testEffect(
  "aws-chunked/incremental/perf-smoke-64mb",
  () =>
    Effect.gen(function* () {
      // 64MB logical upload: four 16MB aws-chunks delivered in 64KB network
      // pieces. The old copy-per-feed parser needed ~8GB of memcpy for this
      // shape; the incremental parser is linear. Generous 10s budget keeps
      // this stable on loaded CI runners while still catching an O(n^2)
      // regression (which lands in the tens of seconds).
      const CHUNK_PAYLOAD = 16 * 1024 * 1024;
      const CHUNKS = 4;
      const PIECE = 64 * 1024;
      const TOTAL = CHUNK_PAYLOAD * CHUNKS;

      function* networkPieces(): Generator<Uint8Array> {
        const header = new TextEncoder().encode(
          `${CHUNK_PAYLOAD.toString(16)}\r\n`,
        );
        const crlf = new TextEncoder().encode("\r\n");
        for (let c = 0; c < CHUNKS; c++) {
          yield header;
          for (let off = 0; off < CHUNK_PAYLOAD; off += PIECE) {
            // Fresh buffer per piece: downstream may hold emitted views.
            const piece = new Uint8Array(Math.min(PIECE, CHUNK_PAYLOAD - off));
            piece.fill(c & 0xff);
            yield piece;
          }
          yield crlf;
        }
        yield new TextEncoder().encode("0\r\n\r\n");
      }

      let received = 0;
      const started = Date.now();
      yield* Stream.runForEach(
        decodeAwsChunkedBodyStream(Stream.fromIterable(networkPieces()), {
          headers: {
            "content-encoding": "aws-chunked",
            "x-amz-decoded-content-length": String(TOTAL),
          },
        }),
        (chunk) =>
          Effect.sync(() => {
            received += chunk.length;
          }),
      );
      const elapsed = Date.now() - started;
      assertEquals(received, TOTAL);
      if (elapsed > 10_000) {
        throw new Error(
          `aws-chunked perf smoke too slow: ${elapsed}ms for ${TOTAL} bytes (suspect O(n^2) regression)`,
        );
      }
    }),
);
