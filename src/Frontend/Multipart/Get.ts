import { Effect } from "effect";
import { S3RequestParser } from "../Utils.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { Backend } from "../../Services/Backend.ts";

export const listParts = Effect.gen(function* () {
  const backend = yield* Backend;
  const { key, s3Params } = yield* S3RequestParser;
  const s3Xml = yield* S3Xml;

  const result = yield* backend.listParts(key, s3Params.uploadId!);
  return s3Xml.formatListParts(result);
});
