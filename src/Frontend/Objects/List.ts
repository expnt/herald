import { Effect } from "effect";
import { RequestContext } from "../Utils.ts";
import { S3Xml } from "../../Services/S3Xml.ts";

/**
 * Handler for ListObjects (GET /:bucket)
 */
export const listObjects = () =>
  Effect.gen(function* () {
    const { backend, params } = yield* RequestContext;
    const s3Xml = yield* S3Xml;

    if (params.versions !== undefined) {
      const result = yield* backend.listVersions({
        prefix: params.prefix,
        delimiter: params.delimiter,
        keyMarker: params["key-marker"],
        versionIdMarker: params["version-id-marker"],
        maxKeys: params["max-keys"],
        encodingType: params["encoding-type"],
      });
      return s3Xml.formatListVersions(result);
    }

    if (params.uploads !== undefined) {
      const result = yield* backend.listMultipartUploads({
        prefix: params.prefix,
        delimiter: params.delimiter,
        keyMarker: params["key-marker"],
        uploadIdMarker: params["upload-id-marker"],
        maxUploads: params["max-uploads"],
        encodingType: params["encoding-type"],
      });
      return s3Xml.formatListMultipartUploads(result);
    }

    const result = yield* backend.listObjects({
      prefix: params.prefix,
      delimiter: params.delimiter,
      marker: params.marker,
      maxKeys: params["max-keys"],
      encodingType: params["encoding-type"],
      continuationToken: params["continuation-token"],
      startAfter: params["start-after"],
      listType: params["list-type"] === "2" ? 2 : 1,
    });

    return s3Xml.formatListObjects(result);
  });
