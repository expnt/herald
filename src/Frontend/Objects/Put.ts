import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { Backend } from "../../Services/Backend.ts";
import { S3RequestParser } from "../Utils.ts";
import { S3HeaderService } from "../../Services/S3HeaderService.ts";
import { uploadPart } from "../Multipart/Put.ts";

/**
 * Handler for PutObject (PUT /:bucket/*)
 */
export const putObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { key, s3Params } = yield* S3RequestParser;
  const headerService = yield* S3HeaderService;

  if (s3Params.partNumber && s3Params.uploadId) {
    return yield* uploadPart;
  }

  const result = yield* backend.putObject(
    key,
    request.stream,
    request.headers,
  );

  return HttpServerResponse.empty({
    status: 200,
    headers: headerService.toResponseHeaders(result),
  });
});
