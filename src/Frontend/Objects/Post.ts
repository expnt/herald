import { Effect, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { extractKey, resolveBucket } from "../Utils.ts";

/**
 * Handler for POST requests on buckets or objects.
 * Primarily used for Multi-Object Delete (POST /:bucket?delete).
 */
export const postObject = (
  { path: { bucket } }: { path: { bucket: string } },
) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://localhost");
      const searchParams = url.searchParams;
      const key = extractKey(request.url, bucket);

      if (searchParams.has("delete")) {
        // Multi-Object Delete
        const bodyChunks = yield* Stream.runCollect(request.stream);
        let totalLength = 0;
        for (const chunk of Array.from(bodyChunks)) {
          totalLength += chunk.length;
        }
        const bodyBytes = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of Array.from(bodyChunks)) {
          bodyBytes.set(chunk, offset);
          offset += chunk.length;
        }
        const bodyText = new TextDecoder().decode(bodyBytes);

        const objects: { key: string; versionId?: string }[] = [];
        // Simple XML parsing for Multi-Object Delete
        const objectMatches = Array.from(
          bodyText.matchAll(/<Object>(.*?)<\/Object>/gs),
        );
        for (const match of objectMatches) {
          const content = match[1];
          const keyMatch = content.match(/<Key>(.*?)<\/Key>/);
          const versionIdMatch = content.match(/<VersionId>(.*?)<\/VersionId>/);
          if (keyMatch) {
            try {
              objects.push({
                key: decodeURIComponent(keyMatch[1]),
                versionId: versionIdMatch ? versionIdMatch[1] : undefined,
              });
            } catch {
              objects.push({
                key: keyMatch[1],
                versionId: versionIdMatch ? versionIdMatch[1] : undefined,
              });
            }
          }
        }

        if (objects.length > 0) {
          const deleteResult = yield* backend.deleteObjects(objects);
          const xml =
            `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${
              deleteResult.deleted.map((k) =>
                `<Deleted><Key>${k}</Key></Deleted>`
              ).join("")
            }</DeleteResult>`;
          return HttpServerResponse.text(xml, {
            headers: { "Content-Type": "application/xml" },
          });
        }
        // If no keys, still return empty result
        const xml =
          `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>`;
        return HttpServerResponse.text(xml, {
          headers: { "Content-Type": "application/xml" },
        });
      }

      return yield* Effect.fail(
        new Error(`Method POST for key [${key}] not implemented`),
      );
    }));
