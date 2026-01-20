import { Effect, Option, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { extractKey, resolveBucket } from "../Utils.ts";
import { S3Xml } from "../../Services/S3Xml.ts";

/**
 * Handler for POST requests on buckets or objects.
 * Primarily used for Multi-Object Delete (POST /:bucket?delete).
 * Also handles InitiateMultipartUpload (?uploads) and CompleteMultipartUpload (?uploadId=...).
 */
export const postObject = (
  { path: { bucket } }: { path: { bucket: string } },
) =>
  resolveBucket(bucket, (backend) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const s3Xml = yield* S3Xml;
      const url = new URL(request.url, "http://localhost");
      const searchParams = url.searchParams;
      const key = extractKey(request.url, bucket);

      if (searchParams.has("delete")) {
        // ... (Multi-Object Delete logic)
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
            const rawKey = keyMatch[1];
            const key = Option.liftThrowable(decodeURIComponent)(rawKey).pipe(
              Option.getOrElse(() => rawKey),
            );
            yield* Effect.logDebug(`DeleteObjects extracted key=[${key}]`);
            objects.push({
              key,
              versionId: versionIdMatch ? versionIdMatch[1] : undefined,
            });
          }
        }

        if (objects.length > 0) {
          const deleteResult = yield* backend.deleteObjects(objects);
          const deletedXml = deleteResult.deleted.map((k) =>
            `<Deleted><Key>${k}</Key></Deleted>`
          ).join("");
          const errorsXml = deleteResult.errors.map((e) =>
            `<Error><Key>${e.key}</Key><Code>${e.code}</Code><Message>${e.message}</Message></Error>`
          ).join("");

          const xml =
            `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deletedXml}${errorsXml}</DeleteResult>`;
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

      if (searchParams.has("uploads")) {
        // Initiate Multipart Upload
        const result = yield* backend.createMultipartUpload(
          key,
          request.headers,
        );
        return s3Xml.formatInitiateMultipartUpload(
          bucket,
          key,
          result.uploadId,
        );
      }

      if (searchParams.has("uploadId")) {
        // Complete Multipart Upload
        const uploadId = searchParams.get("uploadId")!;
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

        const parts: { etag: string; partNumber: number }[] = [];
        const partMatches = Array.from(
          bodyText.matchAll(/<Part>(.*?)<\/Part>/gs),
        );
        for (const match of partMatches) {
          const content = match[1];
          const partNumberMatch = content.match(
            /<PartNumber>(.*?)<\/PartNumber>/,
          );
          const etagMatch = content.match(/<ETag>(.*?)<\/ETag>/);
          if (partNumberMatch && etagMatch) {
            parts.push({
              partNumber: parseInt(partNumberMatch[1]),
              etag: etagMatch[1].replace(/&quot;/g, '"'),
            });
          }
        }

        const result = yield* backend.completeMultipartUpload(
          key,
          uploadId,
          parts,
        ).pipe(
          Effect.catchTag("NoSuchUpload", (e) =>
            Effect.gen(function* () {
              // Idempotency: check if object already exists
              const head = yield* backend.headObject(key, {}).pipe(
                Effect.orElseFail(() => e),
              );
              if (head.etag) {
                return {
                  location: `http://localhost/${bucket}/${key}`, // Approximate
                  bucket,
                  key,
                  etag: head.etag,
                  versionId: head.headers["x-amz-version-id"],
                };
              }
              return yield* Effect.fail(e);
            })),
        );
        return s3Xml.formatCompleteMultipartUpload(result);
      }

      return yield* Effect.fail(
        new Error(`Method POST for key [${key}] not implemented`),
      );
    }));
