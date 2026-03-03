import { Stream } from "effect";
import { AccessDenied, InvalidRequest } from "./Backend.ts";
import { normalizeHeaders } from "./S3HeaderService.ts";
import type { SigV4VerifiedContext } from "./Auth.ts";
import { createHash, createHmac } from "node-crypto";

const CR = 13;
const LF = 10;
const MAX_CONTROL_LINE_LENGTH = 8 * 1024;
const MAX_CHUNK_SIZE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BUFFERED_BYTES = MAX_CHUNK_SIZE_BYTES +
  MAX_CONTROL_LINE_LENGTH +
  4;
const EMPTY_SHA256_HEX =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SIGV4_STREAMING_ALGORITHM = "AWS4-HMAC-SHA256-PAYLOAD";

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

export type AwsChunkedMode =
  | "none"
  | "aws-chunked-encoding"
  | "streaming-signed-payload"
  | "streaming-unsigned-payload-trailer";

const getSigV4StreamingMode = (
  headers: Record<string, string | string[] | undefined>,
): AwsChunkedMode => {
  const normalized = normalizeHeaders(headers);
  const amzContentSha256 = normalized["x-amz-content-sha256"]?.trim()
    .toUpperCase();
  if (amzContentSha256 === "STREAMING-AWS4-HMAC-SHA256-PAYLOAD") {
    return "streaming-signed-payload";
  }
  if (amzContentSha256 === "STREAMING-UNSIGNED-PAYLOAD-TRAILER") {
    return "streaming-unsigned-payload-trailer";
  }
  const encoding = normalized["content-encoding"];
  const hasDecodedContentLength = normalized["x-amz-decoded-content-length"] !==
      undefined &&
    normalized["x-amz-decoded-content-length"].trim() !== "";
  const hasAwsChunkedEncoding = encoding !== undefined &&
    encoding.trim() !== "" &&
    encoding.toLowerCase().split(",").map((s) => s.trim()).some((token) =>
      token === "aws-chunked"
    );
  return hasAwsChunkedEncoding && hasDecodedContentLength
    ? "aws-chunked-encoding"
    : "none";
};

const deriveSigV4SigningKey = (
  secretAccessKey: string,
  scopeDate: string,
  scopeRegion: string,
  scopeService: string,
): Uint8Array<ArrayBufferLike> => {
  const kDate = createHmac("sha256", `AWS4${secretAccessKey}`)
    .update(scopeDate, "utf8")
    .digest();
  const kRegion = createHmac("sha256", kDate).update(scopeRegion, "utf8")
    .digest();
  const kService = createHmac("sha256", kRegion).update(scopeService, "utf8")
    .digest();
  return createHmac("sha256", kService).update("aws4_request", "utf8").digest();
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
  const expected = createHmac("sha256", signingKey).update(stringToSign, "utf8")
    .digest("hex");
  if (expected !== chunkSignature.toLowerCase()) {
    throw new AccessDenied({
      message:
        "The request signature we calculated does not match the signature you provided.",
    });
  }
  return expected;
};

interface AwsChunkedParserOptions {
  readonly requireChunkSignatures: boolean;
  readonly signingKey?: Uint8Array<ArrayBufferLike>;
  readonly sigV4Context?: SigV4VerifiedContext;
  readonly expectedDecodedLength?: number;
}

class AwsChunkedParser {
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
    if (this.buffer.length > MAX_TOTAL_BUFFERED_BYTES) {
      throw new InvalidRequest({
        message: "Invalid aws-chunked framing",
      });
    }
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
          this.options.requireChunkSignatures && !this.expectedChunkSignature
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

export const hasAwsChunkedContentEncoding = (
  headers: Record<string, string | string[] | undefined>,
): boolean => {
  return getSigV4StreamingMode(headers) !== "none";
};

export const stripAwsChunkedFromContentEncoding = (
  contentEncoding: string | undefined,
): string | undefined => {
  if (contentEncoding === undefined) {
    return undefined;
  }
  const filtered = contentEncoding
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "" && token.toLowerCase() !== "aws-chunked");
  if (filtered.length === 0) {
    return undefined;
  }
  return filtered.join(", ");
};

interface AwsChunkedDecodeOptions {
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly sigV4Context?: SigV4VerifiedContext;
}

export const decodeAwsChunkedBodyStream = (
  stream: Stream.Stream<Uint8Array, Error>,
  options?: AwsChunkedDecodeOptions,
): Stream.Stream<Uint8Array, Error | InvalidRequest | AccessDenied> => {
  const normalized = options?.headers ? normalizeHeaders(options.headers) : {};
  const mode = options?.headers
    ? getSigV4StreamingMode(options.headers)
    : "aws-chunked-encoding";
  const expectedDecodedLengthRaw = normalized["x-amz-decoded-content-length"];
  let expectedDecodedLength: number | undefined;
  if (expectedDecodedLengthRaw !== undefined) {
    const parsedDecodedLength = Number.parseInt(expectedDecodedLengthRaw, 10);
    if (!Number.isInteger(parsedDecodedLength) || parsedDecodedLength < 0) {
      return Stream.fail(
        new InvalidRequest({
          message: "Invalid x-amz-decoded-content-length",
        }),
      );
    }
    expectedDecodedLength = parsedDecodedLength;
  }

  const requireChunkSignatures = mode === "streaming-signed-payload";
  if (requireChunkSignatures && options?.sigV4Context === undefined) {
    return Stream.fail(
      new AccessDenied({
        message:
          "The request signature we calculated does not match the signature you provided.",
      }),
    );
  }
  const signingKey = requireChunkSignatures && options?.sigV4Context
    ? deriveSigV4SigningKey(
      options.sigV4Context.secretAccessKey,
      options.sigV4Context.scopeDate,
      options.sigV4Context.scopeRegion,
      options.sigV4Context.scopeService,
    )
    : undefined;

  const source = Stream.toReadableStream(stream);
  const parser = new AwsChunkedParser({
    requireChunkSignatures,
    signingKey,
    sigV4Context: options?.sigV4Context,
    expectedDecodedLength,
  });
  const decoded = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        try {
          const parts = parser.feed(chunk);
          for (const part of parts) {
            controller.enqueue(part);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      flush(controller) {
        try {
          parser.finish();
        } catch (error) {
          controller.error(error);
        }
      },
    }),
  );

  return Stream.fromReadableStream(
    () => decoded,
    (error) =>
      error instanceof InvalidRequest || error instanceof AccessDenied
        ? error
        : new InvalidRequest({ message: String(error) }),
  );
};
