import { Effect } from "effect";
import { HttpServerRequest } from "@effect/platform";
import { RequestContext, S3RequestParser } from "../Utils.ts";
import { S3Xml } from "../../Services/S3Xml.ts";
import { parseCompleteMultipartUploadRequest } from "../../Services/XmlParser.ts";
import { Backend, InvalidRequest } from "../../Services/Backend.ts";

export const initiateMultipartUpload = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { key } = yield* S3RequestParser;
  const { bucket } = yield* RequestContext;
  const s3Xml = yield* S3Xml;

  const result = yield* backend.createMultipartUpload(key, request.headers);
  return s3Xml.formatInitiateMultipartUpload(bucket, key, result);
});

export const completeMultipartUpload = Effect.gen(function* () {
  const backend = yield* Backend;
  const request = yield* HttpServerRequest.HttpServerRequest;
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

  const bodyText = yield* request.text;
  const parts = yield* parseCompleteMultipartUploadRequest(bodyText);

  const result = yield* backend.completeMultipartUpload(
    key,
    s3Params.uploadId,
    parts,
    {}, // Metadata handled by backend
    request.headers,
  );

  return s3Xml.formatCompleteMultipartUpload(result);
});
