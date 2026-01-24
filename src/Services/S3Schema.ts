import { Schema } from "effect";

/**
 * Checksum algorithm enum - parsed, not cast.
 */
export const ChecksumAlgorithm = Schema.Literal(
  "SHA256",
  "SHA1",
  "CRC32",
  "CRC32C",
  "CRC64NVME",
);
export type ChecksumAlgorithm = Schema.Schema.Type<typeof ChecksumAlgorithm>;

/**
 * Checksum type enum.
 */
export const ChecksumType = Schema.Literal("COMPOSITE", "FULL_OBJECT");
export type ChecksumType = Schema.Schema.Type<typeof ChecksumType>;

/**
 * Header extraction schema - parses headers into typed structure.
 */
export const ChecksumHeaders = Schema.Struct({
  algorithm: Schema.optional(Schema.transform(
    Schema.String,
    ChecksumAlgorithm,
    {
      decode: (s) => s.toUpperCase() as ChecksumAlgorithm,
      encode: (s) => s,
    },
  )),
  sha256: Schema.optional(Schema.String),
  sha1: Schema.optional(Schema.String),
  crc32: Schema.optional(Schema.String),
  crc32c: Schema.optional(Schema.String),
  crc64nvme: Schema.optional(Schema.String),
  type: Schema.optional(ChecksumType),
});
export type ChecksumHeaders = Schema.Schema.Type<typeof ChecksumHeaders>;

/**
 * XML body schema for DeleteObjects.
 */
export const DeleteObjectEntry = Schema.Struct({
  key: Schema.String,
  versionId: Schema.optional(Schema.String),
});
export type DeleteObjectEntry = Schema.Schema.Type<typeof DeleteObjectEntry>;

/**
 * XML body schema for CompleteMultipartUpload part.
 */
export const CompleteMultipartPart = Schema.Struct({
  partNumber: Schema.Number,
  etag: Schema.String,
  checksumSHA256: Schema.optional(Schema.String),
  checksumSHA1: Schema.optional(Schema.String),
  checksumCRC32: Schema.optional(Schema.String),
  checksumCRC32C: Schema.optional(Schema.String),
  checksumCRC64NVME: Schema.optional(Schema.String),
});
export type CompleteMultipartPart = Schema.Schema.Type<
  typeof CompleteMultipartPart
>;

/**
 * Swift Token Response schema.
 */
export const SwiftTokenResponse = Schema.Struct({
  token: Schema.String,
  storageUrl: Schema.String,
});
export type SwiftTokenResponse = Schema.Schema.Type<typeof SwiftTokenResponse>;
