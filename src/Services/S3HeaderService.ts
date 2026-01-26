import { Effect, Schema } from "effect";
import type {
  CompleteMultipartUploadResult,
  HeadObjectResult,
  ObjectResponse,
  PutObjectResult,
  UploadPartResult,
} from "./Backend.ts";
import { ChecksumHeaders } from "./S3Schema.ts";

export const normalizeHeaders = (
  raw: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> => {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
};

export class S3HeaderService
  extends Effect.Service<S3HeaderService>()("S3HeaderService", {
    succeed: {
      toResponseHeaders: (
        result:
          | PutObjectResult
          | ObjectResponse
          | HeadObjectResult
          | UploadPartResult
          | CompleteMultipartUploadResult,
      ): Record<string, string> => {
        const headers: Record<string, string> = {};

        if ("etag" in result && result.etag) headers["ETag"] = result.etag;
        if ("versionId" in result && result.versionId) {
          headers["x-amz-version-id"] = result.versionId;
        }
        if ("lastModified" in result && result.lastModified) {
          headers["Last-Modified"] = result.lastModified.toUTCString();
        }
        if ("contentLength" in result && result.contentLength !== undefined) {
          headers["Content-Length"] = String(result.contentLength);
        }
        if ("contentType" in result && result.contentType) {
          headers["Content-Type"] = result.contentType;
        }

        // Metadata
        if ("metadata" in result && result.metadata) {
          for (const [key, value] of Object.entries(result.metadata)) {
            const lowKey = key.toLowerCase();
            // Skip internal checksum metadata to avoid duplication in response
            if (lowKey.startsWith("s3-checksum-")) {
              continue;
            }
            const encodedValue = /[^\x20-\x7E]/.test(value)
              ? encodeURIComponent(value)
              : value;
            headers[`x-amz-meta-${lowKey}`] = encodedValue;
          }
        }

        // Checksums
        if (result.checksumAlgorithm) {
          headers["x-amz-checksum-algorithm"] = result.checksumAlgorithm
            .toUpperCase();
        }
        if (result.checksumCRC32) {
          headers["x-amz-checksum-crc32"] = result.checksumCRC32;
        }
        if (result.checksumCRC32C) {
          headers["x-amz-checksum-crc32c"] = result.checksumCRC32C;
        }
        if (result.checksumCRC64NVME) {
          headers["x-amz-checksum-crc64nvme"] = result.checksumCRC64NVME;
        }
        if (result.checksumSHA1) {
          headers["x-amz-checksum-sha1"] = result.checksumSHA1;
        }
        if (result.checksumSHA256) {
          headers["x-amz-checksum-sha256"] = result.checksumSHA256;
        }
        if (result.checksumType) {
          headers["x-amz-checksum-type"] = result.checksumType.toUpperCase();
        }
        if ("partsCount" in result && result.partsCount !== undefined) {
          headers["x-amz-mp-parts-count"] = String(result.partsCount);
        }

        return headers;
      },

      fromRequestHeaders: (
        raw: Record<string, string | string[] | undefined>,
      ): {
        readonly checksums: ChecksumHeaders;
        readonly metadata: Record<string, string>;
        readonly objectAttributes: string[];
        readonly s3Params: {
          readonly partNumber?: number;
          readonly uploadId?: string;
          readonly versionId?: string;
          readonly checksumMode?: string;
          readonly contentLength?: number;
        };
      } => {
        const normalized = normalizeHeaders(raw);

        // Extract Checksums
        const checksumInput = {
          algorithm: normalized["x-amz-checksum-algorithm"] ??
            normalized["x-amz-sdk-checksum-algorithm"],
          sha256: normalized["x-amz-checksum-sha256"],
          sha1: normalized["x-amz-checksum-sha1"],
          crc32: normalized["x-amz-checksum-crc32"],
          crc32c: normalized["x-amz-checksum-crc32c"],
          crc64nvme: normalized["x-amz-checksum-crc64nvme"],
          type: normalized["x-amz-checksum-type"],
        };

        const checksums = Schema.decodeUnknownSync(ChecksumHeaders)(
          checksumInput,
        );

        // Extract Metadata
        const metadata: Record<string, string> = {};
        for (const [k, v] of Object.entries(normalized)) {
          if (k.startsWith("x-amz-meta-") && v !== undefined) {
            const metaKey = k.substring("x-amz-meta-".length);
            metadata[metaKey] = v.includes("%") ? decodeURIComponent(v) : v;
          }
        }

        // Extract Object Attributes
        const attributesHeader = normalized["x-amz-object-attributes"];
        const objectAttributes = attributesHeader
          ? attributesHeader.split(",").map((a) => a.trim()).filter((a) =>
            a !== ""
          )
          : [];

        // Extract S3 Params
        const s3Params = {
          partNumber: normalized["x-amz-part-number"]
            ? parseInt(normalized["x-amz-part-number"])
            : undefined,
          uploadId: normalized["x-amz-upload-id"],
          versionId:
            (normalized["x-amz-version-id"] || normalized["versionid"]) ||
            undefined,
          checksumMode: normalized["x-amz-checksum-mode"],
          contentLength: normalized["content-length"]
            ? parseInt(normalized["content-length"])
            : undefined,
        };

        return { checksums, metadata, objectAttributes, s3Params };
      },

      /**
       * Reconstructs S3 headers and metadata from raw Swift headers.
       * Also handles internal checksum metadata correctly.
       */
      fromSwiftHeaders: (
        raw: Record<string, string | string[] | undefined>,
      ): {
        readonly metadata: Record<string, string>;
        readonly s3Headers: Record<string, string>;
        readonly checksums: ChecksumHeaders;
        readonly partsCount?: number;
      } => {
        const normalized = normalizeHeaders(raw);
        const metadata: Record<string, string> = {};
        const s3Headers: Record<string, string> = {};

        for (const [k, v] of Object.entries(normalized)) {
          if (v === undefined) continue;

          if (k.startsWith("x-object-meta-")) {
            const metaKey = k.substring("x-object-meta-".length);

            // CRITICAL: Skip internal checksum metadata when reconstructing generic metadata
            if (metaKey.startsWith("s3-checksum-")) {
              continue;
            }

            const decodedValue = v.includes("%") ? decodeURIComponent(v) : v;
            metadata[metaKey] = decodedValue;
            s3Headers[`x-amz-meta-${metaKey}`] = decodedValue;
          } else if (k === "content-type") {
            s3Headers["Content-Type"] = v;
          } else if (k === "content-length") {
            s3Headers["Content-Length"] = v;
          } else if (k === "etag") {
            s3Headers["ETag"] = v;
          } else if (k === "last-modified") {
            s3Headers["Last-Modified"] = v;
          } else if (k === "x-static-large-object") {
            s3Headers["x-static-large-object"] = v;
          } else if (k === "x-amz-mp-parts-count") {
            s3Headers["x-amz-mp-parts-count"] = v;
          }
        }

        const checksumInput = {
          algorithm: normalized["x-object-meta-s3-checksum-algorithm"],
          sha256: normalized["x-object-meta-s3-checksum-sha256"],
          sha1: normalized["x-object-meta-s3-checksum-sha1"],
          crc32: normalized["x-object-meta-s3-checksum-crc32"],
          crc32c: normalized["x-object-meta-s3-checksum-crc32c"],
          crc64nvme: normalized["x-object-meta-s3-checksum-crc64nvme"],
          type: normalized["x-object-meta-s3-checksum-type"],
        };

        const checksums = Schema.decodeUnknownSync(ChecksumHeaders)(
          checksumInput,
        );
        const partsCount = normalized["x-amz-mp-parts-count"]
          ? parseInt(normalized["x-amz-mp-parts-count"])
          : undefined;

        return { metadata, s3Headers, checksums, partsCount };
      },

      /**
       * Maps S3 metadata and checksums to Swift headers.
       */
      toSwiftHeaders: (
        metadata: Record<string, string>,
        checksums: ChecksumHeaders,
      ): Record<string, string> => {
        const swiftHeaders: Record<string, string> = {};

        // S3 Metadata -> Swift Metadata
        for (const [key, value] of Object.entries(metadata)) {
          const encodedValue = /[^\x20-\x7E]/.test(value)
            ? encodeURIComponent(value)
            : value;
          swiftHeaders[`X-Object-Meta-${key}`] = encodedValue;
        }

        // S3 Checksums -> Swift Metadata (prefixed for later reconstruction)
        if (checksums.algorithm) {
          swiftHeaders["X-Object-Meta-S3-Checksum-Algorithm"] =
            checksums.algorithm;
        }
        if (checksums.crc32) {
          swiftHeaders["X-Object-Meta-S3-Checksum-CRC32"] = checksums.crc32;
        }
        if (checksums.crc32c) {
          swiftHeaders["X-Object-Meta-S3-Checksum-CRC32C"] = checksums.crc32c;
        }
        if (checksums.crc64nvme) {
          swiftHeaders["X-Object-Meta-S3-Checksum-CRC64NVME"] =
            checksums.crc64nvme;
        }
        if (checksums.sha1) {
          swiftHeaders["X-Object-Meta-S3-Checksum-SHA1"] = checksums.sha1;
        }
        if (checksums.sha256) {
          swiftHeaders["X-Object-Meta-S3-Checksum-SHA256"] = checksums.sha256;
        }
        if (checksums.type) {
          swiftHeaders["X-Object-Meta-S3-Checksum-Type"] = checksums.type;
        }

        return swiftHeaders;
      },
    },
  }) {}
