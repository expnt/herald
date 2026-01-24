import { Effect, Schema } from "effect";
import { ChecksumHeaders } from "./S3Schema.ts";
import { InternalError } from "./Backend.ts";

/**
 * Normalizes headers by lowercasing keys and flattening arrays.
 */
export function normalizeHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}

/**
 * Parses checksum headers into a typed structure.
 */
export const parseChecksumHeaders = (
  raw: Record<string, string | string[] | undefined>,
) =>
  Effect.gen(function* () {
    const normalized = normalizeHeaders(raw);
    const input = {
      algorithm: normalized["x-amz-checksum-algorithm"] ??
        normalized["x-amz-sdk-checksum-algorithm"],
      sha256: normalized["x-amz-checksum-sha256"],
      sha1: normalized["x-amz-checksum-sha1"],
      crc32: normalized["x-amz-checksum-crc32"],
      crc32c: normalized["x-amz-checksum-crc32c"],
      crc64nvme: normalized["x-amz-checksum-crc64nvme"],
      type: normalized["x-amz-checksum-type"],
    };

    return yield* Schema.decodeUnknown(ChecksumHeaders)(input).pipe(
      Effect.mapError((e) => new InternalError({ message: String(e) })),
    );
  });

/**
 * Parses GetObjectAttributes headers into a list of requested attributes.
 */
export const parseGetObjectAttributesHeaders = (
  raw: Record<string, string | string[] | undefined>,
) =>
  Effect.gen(function* () {
    const normalized = normalizeHeaders(raw);
    yield* Effect.logDebug(
      `Parsing GetObjectAttributes headers: ${JSON.stringify(normalized)}`,
    );
    const attributesHeader = normalized["x-amz-object-attributes"];
    const attributes = attributesHeader
      ? attributesHeader.split(",").map((a) => a.trim()).filter((a) => a !== "")
      : [];
    return { attributes };
  });
