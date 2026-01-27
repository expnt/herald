import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { S3RequestParser } from "../Utils.ts";
import { parseDeleteObjectsRequest } from "../../Services/XmlParser.ts";
import { Backend } from "../../Services/Backend.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import {
  completeMultipartUpload,
  initiateMultipartUpload,
} from "../Multipart/Post.ts";

/**
 * Handler for POST requests on buckets or objects.
 * Primarily used for Multi-Object Delete (POST /:bucket?delete).
 * Also handles InitiateMultipartUpload (?uploads) and CompleteMultipartUpload (?uploadId=...).
 */
export const postObject = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { s3Params } = yield* S3RequestParser;
  const s3Xml = yield* S3Xml;

  if (s3Params.delete !== undefined) {
    // Multi-Object Delete
    const bodyText = yield* request.text;
    const objects = yield* parseDeleteObjectsRequest(bodyText);

    if (objects.length > 0) {
      const deleteResult = yield* backend.deleteObjects(objects);
      return s3Xml.formatDeleteObjects(deleteResult);
    }
    // If no keys, still return empty result
    return HttpServerResponse.text(
      `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>`,
      { headers: { "Content-Type": "application/xml" } },
    );
  }

  if (s3Params.uploads !== undefined) {
    return yield* initiateMultipartUpload;
  }

  if (s3Params.uploadId) {
    return yield* completeMultipartUpload;
  }

  return yield* Effect.fail(
    new Error(`Method POST not implemented for this request`),
  );
});
