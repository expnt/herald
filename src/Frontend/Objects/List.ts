import { Effect } from "effect";
import { HttpServerRequest } from "@effect/platform";
import { resolveBucket } from "../Utils.ts";
import { S3Xml } from "../../Services/S3Xml.ts";

/**
 * Handler for ListObjects (GET /:bucket)
 */
export const listObjects = (
  { path: { bucket } }: { path: { bucket: string } },
) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const s3Xml = yield* S3Xml;
      const url = new URL(request.url, "http://localhost");
      const searchParams = url.searchParams;

      if (searchParams.has("versions")) {
        const result = yield* backend.listVersions({
          prefix: searchParams.get("prefix") ?? undefined,
          delimiter: searchParams.get("delimiter") ?? undefined,
          keyMarker: searchParams.get("key-marker") ?? undefined,
          versionIdMarker: searchParams.get("version-id-marker") ?? undefined,
          maxKeys: searchParams.has("max-keys")
            ? parseInt(searchParams.get("max-keys")!)
            : undefined,
          encodingType: searchParams.get("encoding-type") ?? undefined,
        });
        return s3Xml.formatListVersions(result);
      }

      const result = yield* backend.listObjects({
        prefix: searchParams.get("prefix") ?? undefined,
        delimiter: searchParams.get("delimiter") ?? undefined,
        marker: searchParams.get("marker") ?? undefined,
        maxKeys: searchParams.has("max-keys")
          ? parseInt(searchParams.get("max-keys")!)
          : undefined,
        encodingType: searchParams.get("encoding-type") ?? undefined,
        continuationToken: searchParams.get("continuation-token") ?? undefined,
        startAfter: searchParams.get("start-after") ?? undefined,
        listType: searchParams.get("list-type") === "2" ? 2 : 1,
      });

      return s3Xml.formatListObjects(result);
    }));
