import { Effect, Option } from "effect";
import { HttpServerResponse } from "@effect/platform";
import { RequestContext } from "../Utils.ts";
import { S3Xml } from "../../Services/S3Xml.ts";

/**
 * Handler for POST requests on buckets or objects.
 * Primarily used for Multi-Object Delete (POST /:bucket?delete).
 * Also handles InitiateMultipartUpload (?uploads) and CompleteMultipartUpload (?uploadId=...).
 */
export const postObject = () =>
  Effect.gen(function* () {
    const { backend, bucket, key, params, request } = yield* RequestContext;
    const s3Xml = yield* S3Xml;

    if (params.delete !== undefined) {
      // Multi-Object Delete
      const bodyText = yield* request.text;

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

    if (params.uploads !== undefined) {
      // Initiate Multipart Upload
      const result = yield* backend.createMultipartUpload(
        key,
        request.headers,
      ).pipe(
        Effect.tapError((e) =>
          Effect.logError(`createMultipartUpload failed: ${e}`)
        ),
      );
      // Save metadata
      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.headers)) {
        const lowK = k.toLowerCase();
        if (lowK.startsWith("x-amz-meta-") || lowK === "content-type") {
          metadata[lowK] = String(v);
        }
      }
      yield* backend.multipartMetadataStore.set(
        `${key}/${result.uploadId}`,
        JSON.stringify(metadata),
      ).pipe(
        Effect.tapError((e) =>
          Effect.logError(`metadataStore.set failed: ${e}`)
        ),
      );

      return s3Xml.formatInitiateMultipartUpload(
        bucket,
        key,
        result.uploadId,
      );
    }

    if (params.uploadId) {
      // Complete Multipart Upload
      const bodyText = yield* request.text;

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

      // Retrieve metadata
      const metadataOpt = yield* backend.multipartMetadataStore.get(
        `${key}/${params.uploadId}`,
      );

      let metadata: Record<string, string> = {};

      if (Option.isNone(metadataOpt)) {
        // Check for idempotency
        const head = yield* backend.headObject(key, {}).pipe(
          Effect.option,
        );
        if (Option.isSome(head) && head.value.etag) {
          return s3Xml.formatCompleteMultipartUpload({
            location: `http://localhost/${bucket}/${key}`, // Approximate
            bucket,
            key,
            etag: head.value.etag,
          });
        }
        // If not completed and no metadata, proceed with empty metadata
        // Backends like Swift will fail if the upload doesn't exist (no segments)
        // Backends like S3 will succeed if S3 says it's okay.
      } else {
        metadata = JSON.parse(metadataOpt.value);
      }

      const result = yield* backend.completeMultipartUpload(
        key,
        params.uploadId,
        parts,
        metadata,
      ).pipe(
        Effect.tap(() =>
          backend.multipartMetadataStore.remove(`${key}/${params.uploadId!}`)
            .pipe(
              Effect.ignore,
            )
        ),
      );

      return s3Xml.formatCompleteMultipartUpload(result);
    }

    return yield* Effect.fail(
      new Error(`Method POST for key [${key}] not implemented`),
    );
  }).pipe(
    Effect.catchAll((e) => {
      return Effect.logError(`postObject error: ${e}`).pipe(
        Effect.zipRight(Effect.fail(e)),
      );
    }),
  );
