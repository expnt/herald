import { Effect } from "effect";
import { S3RequestParser } from "../Utils.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { Backend } from "../../Services/Backend.ts";

export const listMultipartUploads = Effect.gen(function* () {
  const backend = yield* Backend;
  const { s3Params } = yield* S3RequestParser;
  const s3Xml = yield* S3Xml;

  const result = yield* backend.listMultipartUploads({
    prefix: s3Params.prefix,
    delimiter: s3Params.delimiter,
    keyMarker: s3Params["key-marker"],
    uploadIdMarker: s3Params["upload-id-marker"],
    maxUploads: s3Params["max-uploads"],
    encodingType: s3Params["encoding-type"],
  });
  return s3Xml.formatListMultipartUploads(result);
});
