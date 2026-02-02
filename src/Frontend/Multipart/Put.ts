import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { S3RequestParser } from "../Utils.ts";
import { Backend, InvalidRequest } from "../../Services/Backend.ts";
import { S3HeaderService } from "../../Services/S3HeaderService.ts";
import { S3Xml } from "../../Services/S3Xml.ts";

export const uploadPart = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
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
  // Swift backend rejects 0-byte segments at CompleteMultipartUpload (SLO manifest requirement).

  const result = yield* backend.uploadPart(
    key,
    s3Params.uploadId,
    s3Params.partNumber,
    request.stream,
    request.headers,
  ).pipe(
    Effect.catchAll((e) => {
      return Effect.fail(e);
    }),
  );

  const headers = headerService.toResponseHeaders(result);
  if (headers["Content-Length"] === undefined) {
    headers["Content-Length"] = "0";
  }
  return HttpServerResponse.empty({
    status: 200,
    headers,
  });
});
