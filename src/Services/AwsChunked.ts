import { Stream } from "effect";
import { AccessDenied, InvalidRequest } from "./Backend.ts";
import { normalizeHeaders } from "./S3HeaderService.ts";
import type { SigV4VerifiedContext } from "./Auth.ts";
import { createHash, createHmac } from "node-crypto";

const CR = 13;
const LF = 10;
const MAX_CONTROL_LINE_LENGTH = 8 * 1024;
const MAX_CHUNK_SIZE_BYTES = 128 * 1024 * 1024;
// Note: the previous implementation also carried a MAX_TOTAL_BUFFERED_BYTES
// (chunk-limit + control-line-limit) guard on a monolithic accumulation buffer.
// The incremental parser cannot exceed those bounds by construction:
// retained control-line bytes are capped by MAX_CONTROL_LINE_LENGTH and
// payload assembly buffers are sized exactly to the declared chunk size,
// which parseChunkControlLine caps at MAX_CHUNK_SIZE_BYTES.
const EMPTY_SHA256_HEX =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SIGV4_STREAMING_ALGORITHM = "AWS4-HMAC-SHA256-PAYLOAD";

/**
 * Locate the first CRLF in the virtual concatenation
 * `residual[0..residualLen) ++ chunk[start..chunk.length)` without copying
 * either side.
 *
 * Returns where the CR sits (`inChunk` distinguishes the sides) and whether
 * the CRLF straddles the boundary (CR last byte of residual, LF first unconsumed
 * chunk byte). Returns `null` when no complete CRLF is present.
 */
interface CrlfLocation {
  /** Index of the CR byte. */
  readonly crIndex: number;
  /** true when the CR lives in `chunk` rather than `residual`. */
  readonly inChunk: boolean;
  /** true when the CR is the last residual byte and the LF the first chunk byte. */
  readonly straddling: boolean;
}

const findCrlfAcross = (
  residual: Uint8Array<ArrayBufferLike>,
  residualLen: number,
  chunk: Uint8Array<ArrayBufferLike>,
  start: number,
): CrlfLocation | null => {
  for (let i = 0; i < residualLen - 1; i++) {
    if (residual[i] === CR && residual[i + 1] === LF) {
      return { crIndex: i, inChunk: false, straddling: false };
    }
  }
  if (
    residualLen > 0 &&
    residual[residualLen - 1] === CR &&
    start < chunk.length &&
    chunk[start] === LF
  ) {
    return { crIndex: residualLen - 1, inChunk: false, straddling: true };
  }
  for (let i = start; i < chunk.length - 1; i++) {
    if (chunk[i] === CR && chunk[i + 1] === LF) {
      return { crIndex: i, inChunk: true, straddling: false };
    }
  }
  return null;
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
  const amzContentSha256 = normalized["x-amz-content-sha256"]
    ?.trim()
    .toUpperCase();
  if (amzContentSha256 === "STREAMING-AWS4-HMAC-SHA256-PAYLOAD") {
    return "streaming-signed-payload";
  }
  if (amzContentSha256 === "STREAMING-UNSIGNED-PAYLOAD-TRAILER") {
    return "streaming-unsigned-payload-trailer";
  }
  const encoding = normalized["content-encoding"];
  const hasDecodedContentLength =
    normalized["x-amz-decoded-content-length"] !== undefined &&
    normalized["x-amz-decoded-content-length"].trim() !== "";
  const hasAwsChunkedEncoding = encoding !== undefined &&
    encoding.trim() !== "" &&
    encoding
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .some((token) => token === "aws-chunked");
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
  const kRegion = createHmac("sha256", kDate)
    .update(scopeRegion, "utf8")
    .digest();
  const kService = createHmac("sha256", kRegion)
    .update(scopeService, "utf8")
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

export interface AwsChunkedParserOptions {
  readonly requireChunkSignatures: boolean;
  readonly signingKey?: Uint8Array<ArrayBufferLike>;
  readonly sigV4Context?: SigV4VerifiedContext;
  readonly expectedDecodedLength?: number;
}

/**
 * Incremental aws-chunked decoder.
 *
 * Hot-path constraint: this runs on every streaming upload, so `feed()` must
 * not rebuild an accumulated buffer per network chunk — the previous
 * implementation copied the whole buffered range on every feed (O(n^2) memcpy
 * plus GC churn across small TCP segments), which stalled the event loop on
 * large uploads and got the pod killed by liveness probes in production.
 *
 * Copy discipline instead:
 *  - a chunk payload arriving contiguously is emitted as a **view** into the
 *    incoming chunk (zero copy);
 *  - a payload straddling a feed boundary is assembled **once** into a buffer
 *    sized exactly to the declared chunk size (bounded by MAX_CHUNK_SIZE_BYTES);
 *  - only control lines / CRLF fragments are retained between feeds, and those
 *    are bounded by the control-line length guards.
 *
 * Emitted views alias the caller's chunk buffer; upstream hands us immutable
 * chunks (Effect `Stream.toReadableStream`), so sharing is safe.
 */
export class AwsChunkedParser {
  private expectedSize = 0;
  private expectedChunkSignature: string | undefined;
  private phase: "size" | "data" | "data-crlf" | "trailers" | "done" = "size";
  private readonly decoder = new TextDecoder();
  private previousSignature: string | undefined;
  private decodedBytes = 0;

  /** Retained bytes between feeds (control-line/CRLF fragments only). */
  private residual: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private residualLen = 0;

  /** Partial payload assembly buffer (only while mid-payload). */
  private assembly: Uint8Array<ArrayBufferLike> | undefined;
  private assemblyLen = 0;

  constructor(private readonly options: AwsChunkedParserOptions) {
    this.previousSignature = options.sigV4Context?.initialSignature
      .toLowerCase();
  }

  /** Append `chunk[start..end)` to the residual buffer, growing geometrically. */
  private appendResidual(
    chunk: Uint8Array<ArrayBufferLike>,
    start: number,
    end: number,
  ): void {
    const extra = end - start;
    if (extra <= 0) return;
    if (this.residual.length < this.residualLen + extra) {
      let capacity = Math.max(64, this.residual.length * 2);
      while (capacity < this.residualLen + extra) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.residual.subarray(0, this.residualLen));
      this.residual = grown;
    }
    this.residual.set(chunk.subarray(start, end), this.residualLen);
    this.residualLen += extra;
  }

  /** Drop the first `n` residual bytes, keeping the tail contiguous. */
  private consumeResidual(n: number): void {
    if (n <= 0) return;
    this.residual.set(this.residual.subarray(n, this.residualLen));
    this.residualLen -= n;
  }

  /** Verify (when required) and emit one complete chunk payload. */
  private emitPayload(
    payload: Uint8Array<ArrayBufferLike>,
    out: Uint8Array<ArrayBufferLike>[],
  ): void {
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
  }

  /**
   * Consume one CRLF-terminated line spanning residual/chunk and return its
   * decoded text plus how many chunk bytes were consumed (including CRLF).
   * Throws the phase-appropriate oversize error when no CRLF exists and the
   * buffered line exceeds MAX_CONTROL_LINE_LENGTH.
   */
  private readLine(
    chunk: Uint8Array<ArrayBufferLike>,
    idx: number,
    oversizeMessage: string,
  ): { line: string; consumed: number } | undefined {
    const found = findCrlfAcross(this.residual, this.residualLen, chunk, idx);
    if (found === null) {
      if (this.residualLen + (chunk.length - idx) > MAX_CONTROL_LINE_LENGTH) {
        throw new InvalidRequest({ message: oversizeMessage });
      }
      this.appendResidual(chunk, idx, chunk.length);
      return undefined;
    }
    if (found.inChunk) {
      const line = this.residualLen === 0
        ? this.decoder.decode(chunk.subarray(idx, found.crIndex))
        : this.decodeLineAcross(chunk, idx, found.crIndex);
      this.residualLen = 0;
      return { line, consumed: found.crIndex + 2 - idx };
    }
    // Line lives in the residual. The straddling case contributes its LF from
    // the chunk's first unconsumed byte.
    const lineBytes = this.residual.subarray(0, found.crIndex);
    const line = this.decoder.decode(lineBytes);
    if (found.straddling) {
      this.residualLen = 0;
      return { line, consumed: 1 };
    }
    this.consumeResidual(found.crIndex + 2);
    return { line, consumed: 0 };
  }

  /**
   * Decode a line that starts in the residual buffer and ends inside `chunk`:
   * materialize `residual ++ chunk[start..crInChunk)` as one contiguous buffer.
   * Only used for CRLF-terminated lines, which the oversize guards keep small.
   */
  private decodeLineAcross(
    chunk: Uint8Array<ArrayBufferLike>,
    start: number,
    crInChunk: number,
  ): string {
    const merged = new Uint8Array(this.residualLen + crInChunk - start);
    merged.set(this.residual.subarray(0, this.residualLen), 0);
    merged.set(chunk.subarray(start, crInChunk), this.residualLen);
    return this.decoder.decode(merged);
  }

  feed(chunk: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike>[] {
    const out: Uint8Array<ArrayBufferLike>[] = [];
    let idx = 0;

    while (true) {
      if (this.phase === "done") {
        if (this.residualLen > 0 || idx < chunk.length) {
          throw new InvalidRequest({
            message: "Unexpected trailing data after aws-chunked payload",
          });
        }
        break;
      }

      if (this.phase === "size") {
        const read = this.readLine(
          chunk,
          idx,
          "Invalid aws-chunked chunk-size line",
        );
        if (read === undefined) break;
        idx += read.consumed;
        const parsed = parseChunkControlLine(read.line);
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
        if (this.assembly !== undefined) {
          // Mid-payload: fill the exact-size assembly buffer. Each input byte
          // is copied exactly once for the lifetime of this payload.
          const need = this.expectedSize - this.assemblyLen;
          const take = Math.min(need, chunk.length - idx);
          this.assembly.set(chunk.subarray(idx, idx + take), this.assemblyLen);
          this.assemblyLen += take;
          idx += take;
          if (this.assemblyLen < this.expectedSize) break;
          const payload = this.assembly;
          this.assembly = undefined;
          this.assemblyLen = 0;
          this.emitPayload(payload, out);
          this.phase = "data-crlf";
          continue;
        }
        const available = chunk.length - idx;
        if (available < this.expectedSize) {
          if (available === 0) break;
          this.assembly = new Uint8Array(this.expectedSize);
          this.assembly.set(chunk.subarray(idx), 0);
          this.assemblyLen = available;
          idx = chunk.length;
          break;
        }
        // Contiguous payload: emit a view, zero copy.
        const payload = chunk.subarray(idx, idx + this.expectedSize);
        this.emitPayload(payload, out);
        idx += this.expectedSize;
        this.phase = "data-crlf";
        continue;
      }

      if (this.phase === "data-crlf") {
        if (this.residualLen >= 2) {
          if (this.residual[0] !== CR || this.residual[1] !== LF) {
            throw new InvalidRequest({
              message: "Invalid aws-chunked framing after chunk data",
            });
          }
          this.consumeResidual(2);
          this.phase = "size";
          continue;
        }
        if (this.residualLen === 1) {
          if (idx >= chunk.length) break;
          if (this.residual[0] !== CR || chunk[idx] !== LF) {
            throw new InvalidRequest({
              message: "Invalid aws-chunked framing after chunk data",
            });
          }
          this.residualLen = 0;
          idx += 1;
          this.phase = "size";
          continue;
        }
        const available = chunk.length - idx;
        if (available === 0) break;
        if (available === 1) {
          this.appendResidual(chunk, idx, idx + 1);
          idx += 1;
          break;
        }
        if (chunk[idx] !== CR || chunk[idx + 1] !== LF) {
          throw new InvalidRequest({
            message: "Invalid aws-chunked framing after chunk data",
          });
        }
        idx += 2;
        this.phase = "size";
        continue;
      }

      if (this.phase === "trailers") {
        const read = this.readLine(chunk, idx, "Invalid aws-chunked framing");
        if (read === undefined) break;
        idx += read.consumed;
        if (read.line.length === 0) {
          this.phase = "done";
        }
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
    if (this.residualLen !== 0) {
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
