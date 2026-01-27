import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { S3RequestParser } from "../Utils.ts";
import { Backend } from "../../Services/Backend.ts";

export const abortMultipartUpload = Effect.gen(function* () {
  const backend = yield* Backend;
  const { key, s3Params } = yield* S3RequestParser;

  yield* backend.abortMultipartUpload(key, s3Params.uploadId!);
  return HttpServerResponse.empty({ status: 204 });
});
