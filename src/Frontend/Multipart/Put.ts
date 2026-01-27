import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { S3RequestParser } from "../Utils.ts";
import { Backend } from "../../Services/Backend.ts";
import { S3HeaderService } from "../../Services/S3HeaderService.ts";

export const uploadPart = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { key, s3Params } = yield* S3RequestParser;
  const headerService = yield* S3HeaderService;

  const result = yield* backend.uploadPart(
    key,
    s3Params.uploadId!,
    s3Params.partNumber!,
    request.stream,
    request.headers,
  ).pipe(
    Effect.catchAll((e) => {
      return Effect.fail(e);
    }),
  );

  return HttpServerResponse.empty({
    status: 200,
    headers: headerService.toResponseHeaders(result),
  });
});
