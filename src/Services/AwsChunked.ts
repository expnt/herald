import { Stream } from "effect";
import { InvalidRequest } from "./Backend.ts";
import { normalizeHeaders } from "./S3HeaderService.ts";

const CR = 13;
const LF = 10;
const MAX_CONTROL_LINE_LENGTH = 8 * 1024;
const MAX_CHUNK_SIZE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BUFFERED_BYTES = MAX_CHUNK_SIZE_BYTES +
  MAX_CONTROL_LINE_LENGTH +
  4;

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

const parseChunkSizeLine = (line: string): number => {
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
  return size;
};

class AwsChunkedParser {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private expectedSize = 0;
  private phase: "size" | "data" | "data-crlf" | "trailers" | "done" = "size";
  private readonly decoder = new TextDecoder();

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
        const lineBytes = this.buffer.slice(0, idx);
        const line = this.decoder.decode(lineBytes);
        this.buffer = this.buffer.slice(idx + 2);
        this.expectedSize = parseChunkSizeLine(line);
        if (this.expectedSize === 0) {
          this.phase = "trailers";
        } else {
          this.phase = "data";
        }
        continue;
      }

      if (this.phase === "data") {
        if (this.buffer.length < this.expectedSize) break;
        out.push(this.buffer.slice(0, this.expectedSize));
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
  const normalized = normalizeHeaders(headers);
  const encoding = normalized["content-encoding"];
  if (encoding === undefined || encoding.trim() === "") {
    return false;
  }
  return encoding.toLowerCase().split(",").map((s) => s.trim()).some((token) =>
    token === "aws-chunked"
  );
};

export const decodeAwsChunkedBodyStream = (
  stream: Stream.Stream<Uint8Array, Error>,
): Stream.Stream<Uint8Array, Error | InvalidRequest> => {
  const source = Stream.toReadableStream(stream);
  const parser = new AwsChunkedParser();
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
      error instanceof InvalidRequest
        ? error
        : new InvalidRequest({ message: String(error) }),
  );
};
