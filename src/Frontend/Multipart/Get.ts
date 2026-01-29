import { Effect } from "effect";
import { S3RequestParser } from "../Utils.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { Backend, InvalidRequest } from "../../Services/Backend.ts";

export const listParts = Effect.gen(function* () {
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

  const result = yield* backend.listParts(key, s3Params.uploadId);
  return s3Xml.formatListParts(result);
});
