import { Effect } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { S3RequestParser } from "../Utils.ts";
import { Backend, InvalidRequest } from "../../Services/Backend.ts";
import { S3Xml } from "../../Services/S3Xml.ts";

export const abortMultipartUpload = Effect.gen(function* () {
  const backend = yield* Backend;
  const { key, s3Params } = yield* S3RequestParser;
  const s3Xml = yield* S3Xml;

  // Validate required parameters before calling backend
  if (!s3Params.uploadId || typeof s3Params.uploadId !== "string") {
    return s3Xml.formatError(
      new InvalidRequest({
        message: "Missing or invalid uploadId parameter",
      }),
    );
  }

  yield* backend.abortMultipartUpload(key, s3Params.uploadId);
  return HttpServerResponse.empty({
    status: 204,
    headers: {},
  });
});
