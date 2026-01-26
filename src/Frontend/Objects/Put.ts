import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { Backend } from "../../Services/Backend.ts";
import { S3RequestParser } from "../Utils.ts";
import { S3HeaderService } from "../../Services/S3HeaderService.ts";

/**
 * Handler for PutObject (PUT /:bucket/*)
 */
export const putObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const parser = yield* S3RequestParser;
  const key = yield* parser.key;
  const params = yield* parser.params;
  const headerService = yield* S3HeaderService;

  const headersWithLen = { ...request.headers };
  const len = request.headers["content-length"];
  if (len) {
    headersWithLen["content-length"] = len;
  }

  if (params.partNumber && params.uploadId) {
    // Upload Part
    const result = yield* backend.uploadPart(
      key,
      params.uploadId,
      params.partNumber,
      request.stream,
      headersWithLen,
    );

    return HttpServerResponse.empty({
      status: 200,
      headers: headerService.toResponseHeaders(result),
    });
  }

  const result = yield* backend.putObject(
    key,
    request.stream,
    headersWithLen,
  );

  return HttpServerResponse.empty({
    status: 200,
    headers: headerService.toResponseHeaders(result),
  });
});
