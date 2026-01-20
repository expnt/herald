import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { extractKey, resolveBucket } from "../Utils.ts";
import { S3Xml } from "../../Services/S3Xml.ts";

/**
 * Handler for GetObject (GET /:bucket/*)
 * Also handles ListParts (?uploadId=...).
 */
export const getObject = ({ path: { bucket } }: { path: { bucket: string } }) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const s3Xml = yield* S3Xml;
      const key = extractKey(request.url, bucket);
      const url = new URL(request.url, "http://localhost");
      const searchParams = url.searchParams;

      if (searchParams.has("uploadId")) {
        // List Parts
        const uploadId = searchParams.get("uploadId")!;
        const result = yield* backend.listParts(key, uploadId);
        return s3Xml.formatListParts(result);
      }

      const combinedHeaders = { ...request.headers };
      if (searchParams.has("partNumber")) {
        combinedHeaders["x-amz-part-number"] = searchParams.get("partNumber")!;
      }

      const result = yield* backend.getObject(key, combinedHeaders);
      const status = (request.headers["range"] || request.headers["Range"])
        ? 206
        : 200;
      return HttpServerResponse.stream(result.stream, {
        status,
        headers: result.headers,
        contentType: result.contentType,
      });
    }));
