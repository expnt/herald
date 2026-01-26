import { Effect, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { RequestContext, S3RequestParser } from "../Utils.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import {
  parseCompleteMultipartUploadRequest,
  parseDeleteObjectsRequest,
} from "../../Services/XmlParser.ts";
import { Backend } from "../../Services/Backend.ts";

/**
 * Handler for POST requests on buckets or objects.
 * Primarily used for Multi-Object Delete (POST /:bucket?delete).
 * Also handles InitiateMultipartUpload (?uploads) and CompleteMultipartUpload (?uploadId=...).
 */
export const postObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const parser = yield* S3RequestParser;
  const key = yield* parser.key;
  const params = yield* parser.params;
  const { bucket } = yield* RequestContext;
  const s3Xml = yield* S3Xml;

  if (params.delete !== undefined) {
    // Multi-Object Delete
    const bodyText = yield* request.text;
    const objects = yield* parseDeleteObjectsRequest(bodyText);

    if (objects.length > 0) {
      const deleteResult = yield* backend.deleteObjects(objects);
      const deletedXml = deleteResult.deleted.map((k) =>
        `<Deleted><Key>${k}</Key></Deleted>`
      ).join("");
      const errorsXml = deleteResult.errors.map((e) =>
        `<Error><Key>${e.key}</Key><Code>${e.code}</Code><Message>${e.message}</Message></Error>`
      ).join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deletedXml}${errorsXml}</DeleteResult>`;
      return HttpServerResponse.text(xml, {
        headers: { "Content-Type": "application/xml" },
      });
    }
    // If no keys, still return empty result
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>`;
    return HttpServerResponse.text(xml, {
      headers: { "Content-Type": "application/xml" },
    });
  }

  if (params.uploads !== undefined) {
    // Initiate Multipart Upload
    const result = yield* backend.createMultipartUpload(
      key,
      request.headers,
    ).pipe(
      Effect.tapError((e) =>
        Effect.logError(`createMultipartUpload failed: ${e}`)
      ),
    );
    // Save metadata
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      const lowK = k.toLowerCase();
      if (
        lowK.startsWith("x-amz-meta-") ||
        lowK === "content-type" ||
        lowK.startsWith("x-amz-checksum-") ||
        lowK === "x-amz-sdk-checksum-algorithm"
      ) {
        metadata[lowK] = String(v);
      }
    }
    const finalChecksumAlgorithm = (
      result.checksumAlgorithm ??
        metadata["x-amz-checksum-algorithm"] ??
        metadata["x-amz-sdk-checksum-algorithm"]
    )?.toUpperCase();
    const finalChecksumType = (
      result.checksumType ??
        metadata["x-amz-checksum-type"]
    )?.toUpperCase();

    if (finalChecksumAlgorithm) {
      metadata["x-amz-checksum-algorithm"] = finalChecksumAlgorithm;
    }
    if (finalChecksumType) {
      metadata["x-amz-checksum-type"] = finalChecksumType;
    }

    yield* backend.multipartMetadataStore.set(
      `${key}/${result.uploadId}`,
      JSON.stringify(metadata),
    ).pipe(
      Effect.tapError((e) => Effect.logError(`metadataStore.set failed: ${e}`)),
    );

    return s3Xml.formatInitiateMultipartUpload(
      bucket,
      key,
      result.uploadId,
      finalChecksumAlgorithm,
      finalChecksumType,
    ).pipe(
      HttpServerResponse.setHeader(
        "x-amz-checksum-algorithm",
        finalChecksumAlgorithm ?? "",
      ),
      HttpServerResponse.setHeader(
        "x-amz-checksum-type",
        finalChecksumType ?? "",
      ),
    );
  }

  if (params.uploadId) {
    // Complete Multipart Upload
    const bodyText = yield* request.text;
    const parts = yield* parseCompleteMultipartUploadRequest(bodyText);

    // Retrieve metadata
    const metadataOpt = yield* backend.multipartMetadataStore.get(
      `${key}/${params.uploadId}`,
    );

    let metadata: Record<string, string> = {};

    if (Option.isNone(metadataOpt)) {
      // Check for idempotency
      const head = yield* backend.headObject(key, {}).pipe(
        Effect.option,
      );
      if (Option.isSome(head) && head.value.etag) {
        const baseUrl = deriveBaseUrl(request);
        return s3Xml.formatCompleteMultipartUpload({
          location: `${baseUrl}/${bucket}/${key}`,
          bucket,
          key,
          etag: head.value.etag,
        });
      }
      // If not completed and no metadata, proceed with empty metadata
      // Backends like Swift will fail if the upload doesn't exist (no segments)
      // Backends like S3 will succeed if S3 says it's okay.
    } else {
      try {
        metadata = JSON.parse(metadataOpt.value);
      } catch (e) {
        yield* Effect.logError(
          `Failed to parse multipart metadata for ${key}/${params.uploadId}: ${e}`,
        );
      }
    }

    const result = yield* backend.completeMultipartUpload(
      key,
      params.uploadId,
      parts,
      metadata,
      { ...request.headers, ...metadata },
    ).pipe(
      Effect.tap(() =>
        backend.multipartMetadataStore.remove(`${key}/${params.uploadId!}`)
          .pipe(
            Effect.ignore,
          )
      ),
    );

    return s3Xml.formatCompleteMultipartUpload(result);
  }

  return yield* Effect.fail(
    new Error(`Method POST for key [${key}] not implemented`),
  );
});

/**
 * Derives the base URL for the S3 response, using the Host header.
 */
function deriveBaseUrl(
  request: HttpServerRequest.HttpServerRequest,
): string {
  const host = request.headers["host"] || "localhost";
  const protocol = request.url.startsWith("https") ? "https" : "http";
  return `${protocol}://${host}`;
}
