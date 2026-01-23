import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";

/**
 * Handler for PutObject (PUT /:bucket/*)
 */
export const putObject = () =>
  Effect.gen(function* () {
    const { backend, key, params, request } = yield* RequestContext;

    if (params.partNumber && params.uploadId) {
      // Upload Part
      const result = yield* backend.uploadPart(
        key,
        params.uploadId,
        params.partNumber,
        request.stream,
        request.headers,
      );
      const headers: Record<string, string> = { ETag: result.etag };
      if (result.checksumAlgorithm) {
        headers["x-amz-checksum-algorithm"] = result.checksumAlgorithm;
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

      return HttpServerResponse.empty({
        status: 200,
        headers,
      });
    }

    const result = yield* backend.putObject(
      key,
      request.stream,
      request.headers,
    );
    const headers: Record<string, string> = {};
    if (result.etag) headers["ETag"] = result.etag;
    if (result.versionId) headers["x-amz-version-id"] = result.versionId;
    if (result.checksumAlgorithm) {
      headers["x-amz-checksum-algorithm"] = result.checksumAlgorithm;
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

    return HttpServerResponse.empty({
      status: 200,
      headers,
    });
  });
