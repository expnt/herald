import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { S3RequestParser } from "../Utils.ts";
import {
  decodeAwsChunkedBodyStream,
  hasAwsChunkedContentEncoding,
} from "../../Services/AwsChunked.ts";
import { Backend, InvalidRequest } from "../../Services/Backend.ts";
import { S3HeaderService } from "../../Services/S3HeaderService.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { RequestContext } from "../Utils.ts";

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === lower,
  );
  if (!entry) return undefined;
  const v = entry[1];
  return Array.isArray(v) ? v[0] : v;
}

export const uploadPart = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { sigV4Context } = yield* RequestContext;
  const { key, s3Params } = yield* S3RequestParser;
  const headerService = yield* S3HeaderService;
  const s3Xml = yield* S3Xml;

  // Validate required parameters before calling backend
  if (!s3Params.uploadId || typeof s3Params.uploadId !== "string") {
    return s3Xml.formatError(
      new InvalidRequest({
        message: "Missing or invalid uploadId parameter",
      }),
    );
  }

  if (
    s3Params.partNumber === undefined ||
    s3Params.partNumber === null ||
    typeof s3Params.partNumber !== "number" ||
    !Number.isInteger(s3Params.partNumber) ||
    s3Params.partNumber < 1
  ) {
    return s3Xml.formatError(
      new InvalidRequest({
        message: "Missing or invalid partNumber parameter",
      }),
    );
  }

  // S3 allows 0-byte for the last part; no Frontend rejection here.
  // Swift handles 0-byte parts at CompleteMultipartUpload (omits trailing,
  // rejects zero-byte parts before a non-empty part).
  const hasAwsChunked = hasAwsChunkedContentEncoding(request.headers);
  yield* Effect.logDebug("UploadPart aws-chunked decision", {
    key,
    uploadId: s3Params.uploadId,
    partNumber: s3Params.partNumber,
    hasAwsChunked,
    contentEncoding: getHeader(request.headers, "content-encoding"),
    transferEncoding: getHeader(request.headers, "transfer-encoding"),
    amzContentSha256: getHeader(request.headers, "x-amz-content-sha256"),
    amzDecodedContentLength: getHeader(
      request.headers,
      "x-amz-decoded-content-length",
    ),
    contentLength: getHeader(request.headers, "content-length"),
    contentType: getHeader(request.headers, "content-type"),
  });
  const bodyStream = hasAwsChunked
    ? decodeAwsChunkedBodyStream(request.stream, {
      headers: hasAwsChunked && sigV4Context === undefined
        ? {
          ...request.headers,
          // No auth context available: decode framing only and skip chunk-signature verification.
          "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        }
        : request.headers,
      sigV4Context,
    })
    : request.stream;

  const result = yield* backend.uploadPart(
    key,
    s3Params.uploadId,
    s3Params.partNumber,
    bodyStream,
    request.headers,
  ).pipe(
    Effect.catchAll((e) => {
      return Effect.fail(e);
    }),
  );

  const headers = headerService.toResponseHeaders(result);
  return HttpServerResponse.empty({
    status: 200,
    headers,
  });
});
