import { Effect } from "effect";
import { Backend } from "../../Services/Backend.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { S3RequestParser } from "../Utils.ts";
import { listMultipartUploads } from "../Multipart/List.ts";

/**
 * Handler for ListObjects (GET /:bucket)
 */
export const listObjects = Effect.gen(function* () {
  const backend = yield* Backend;
  const { s3Params } = yield* S3RequestParser;
  const s3Xml = yield* S3Xml;

  if (s3Params.versions !== undefined) {
    const result = yield* backend.listVersions({
      prefix: s3Params.prefix,
      delimiter: s3Params.delimiter,
      keyMarker: s3Params["key-marker"],
      versionIdMarker: s3Params["version-id-marker"],
      maxKeys: s3Params["max-keys"],
      encodingType: s3Params["encoding-type"],
    });
    return s3Xml.formatListVersions(result);
  }

  if (s3Params.uploads !== undefined) {
    return yield* listMultipartUploads;
  }

  const result = yield* backend.listObjects({
    prefix: s3Params.prefix,
    delimiter: s3Params.delimiter,
    marker: s3Params.marker,
    maxKeys: s3Params["max-keys"],
    encodingType: s3Params["encoding-type"],
    continuationToken: s3Params["continuation-token"],
    startAfter: s3Params["start-after"],
    listType: s3Params["list-type"] === "2" ? 2 : 1,
  });

  return s3Xml.formatListObjects(result);
});
