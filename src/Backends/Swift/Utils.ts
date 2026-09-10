import {
  AccessDenied,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  BucketNotEmpty,
  InternalError,
  NoSuchBucket,
  NoSuchKey,
} from "../../Services/Backend.ts";
import type { HttpClient } from "@effect/platform";
import type { S3HeaderService } from "../../Services/S3HeaderService.ts";
import type { Checksum } from "../../Services/Checksum.ts";

export interface SwiftTarget {
  readonly client: HttpClient.HttpClient;
  readonly container: string;
  readonly storageUrl: string;
  readonly token: string;
  readonly url: string;
  readonly headerService: S3HeaderService;
  readonly checksumService: Checksum;
}

export const MP_META_PREFIX = ".hrld/uplds/";
export const MP_SEGMENTS_PREFIX = ".hrld/sgmnts/";

/**
 * Error message used whenever an upload fails because the client closed its
 * request body before the payload completed. Kept as a stable constant so
 * cause-chain inspection can recognize mapped disconnects after undici and
 * the HTTP client layers wrap them.
 */
export const CLIENT_DISCONNECT_MESSAGE =
  "The client closed the request body before the upload was completed";

const isInboundRequestErrorShape = (error: unknown): boolean => {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { _tag?: unknown; reason?: unknown };
  return candidate._tag === "RequestError" && candidate.reason === "Decode";
};

/**
 * Detects an inbound client abort. The platform's HttpServerRequest.stream
 * reports every inbound body failure as a RequestError with reason "Decode",
 * which must not be confused with a Herald server fault (HTTP 500).
 */
export const isInboundClientDisconnect = (error: unknown): boolean =>
  isInboundRequestErrorShape(error);

/**
 * Walks an error's cause chain looking for evidence that the original failure
 * was a client-side disconnect: either the platform's inbound-body RequestError
 * shape or our own mapped CLIENT_DISCONNECT_MESSAGE marker.
 */
export const causeChainHasClientDisconnect = (
  error: unknown,
  depth = 0,
): boolean => {
  if (depth > 8) return false;
  if (isInboundClientDisconnect(error)) return true;
  if (typeof error === "object" && error !== null) {
    if (String(error).includes(CLIENT_DISCONNECT_MESSAGE)) return true;
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== error) {
      return causeChainHasClientDisconnect(cause, depth + 1);
    }
  }
  return false;
};

const parseNonNegativeInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
};

/**
 * Resolves the payload length Herald should declare on the outbound Swift
 * request. With AWS streaming framing (aws-chunked content encoding or a
 * STREAMING-* x-amz-content-sha256), the inbound Content-Length describes the
 * wire format including chunk overhead, so x-amz-decoded-content-length is the
 * only trustworthy payload size. Without framing, Content-Length is exact, and
 * when neither header is present no length can be declared (the outbound
 * request falls back to chunked transfer).
 */
export const resolveOutboundContentLength = (
  normalized: Record<string, string | undefined>,
): number | undefined => {
  const contentEncoding = normalized["content-encoding"];
  const hasAwsChunked = contentEncoding !== undefined &&
    contentEncoding
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .includes("aws-chunked");
  const amzContentSha256 = normalized["x-amz-content-sha256"];
  const hasStreamingSigV4 = amzContentSha256 !== undefined &&
    amzContentSha256.trim().toUpperCase().startsWith("STREAMING-");
  const decodedLength = parseNonNegativeInt(
    normalized["x-amz-decoded-content-length"],
  );
  if ((hasAwsChunked || hasStreamingSigV4) && decodedLength !== undefined) {
    return decodedLength;
  }
  return parseNonNegativeInt(normalized["content-length"]);
};

/**
 * Encodes an object key for use in Swift URL paths. Decodes each segment first
 * to avoid double-encoding when the key already contains percent-encoded chars
 * (e.g. %2F from the client).
 */
export function encodeObjectKeyForSwift(key: string): string {
  return key
    .split("/")
    .map((seg) => {
      try {
        return encodeURIComponent(decodeURIComponent(seg));
      } catch {
        return encodeURIComponent(seg);
      }
    })
    .join("/");
}

/**
 * Format an unknown error from Swift HTTP client for logging. Extracts
 * cause/reason when present so transport failures can be diagnosed.
 */
export function formatSwiftTransportError(e: unknown): string {
  const base = String(e);
  if (e === null || typeof e !== "object") return base;
  const parts = [base];
  if ("cause" in e && (e as { cause?: unknown }).cause !== undefined) {
    parts.push(`cause=${String((e as { cause: unknown }).cause)}`);
  }
  if ("reason" in e && (e as { reason?: unknown }).reason !== undefined) {
    parts.push(`reason=${String((e as { reason: unknown }).reason)}`);
  }
  return parts.join(" ");
}

export const mapError = (
  status: number,
  message: string,
  bucket: string,
  method?: string,
  key?: string,
) => {
  if (status === 404) {
    if (key) {
      return new NoSuchKey({ bucket, key, message });
    }
    return new NoSuchBucket({ bucket, message });
  }
  if (status === 409) {
    if (message.includes("not empty")) {
      return new BucketNotEmpty({ bucket, message });
    }
    if (message.includes("already exists")) {
      return new BucketAlreadyExists({ bucket, message });
    }
    // A 409 on a bucket-level operation is only BucketAlreadyOwnedByYou when
    // the backend explicitly reports the bucket already exists and is owned.
    // Any other 409 (e.g. a conflict from a subresource operation) must not be
    // misreported as a bucket ownership error.
    if (
      message.includes("already owned") ||
      message.includes("you already own")
    ) {
      return new BucketAlreadyOwnedByYou({ bucket, message });
    }
    if (key) {
      return new InternalError({
        message: `Swift Conflict [409] on ${
          method ?? "UNKNOWN"
        } for object ${key}: ${message}`,
      });
    }
    return new InternalError({
      message: `Swift Conflict [409] on ${
        method ?? "UNKNOWN"
      } for bucket ${bucket}: ${message}`,
    });
  }
  if (status === 403) {
    return new AccessDenied({ message });
  }
  return new InternalError({
    message: `Swift Error [${status}] on ${method ?? "UNKNOWN"}: ${message}`,
  });
};
