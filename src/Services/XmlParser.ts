import { Effect, Schema } from "effect";
import { CompleteMultipartPart, DeleteObjectEntry } from "./S3Schema.ts";
import { MalformedXML } from "./Backend.ts";

/**
 * Simple XML parser that extracts elements and their text content.
 * This is a placeholder for a more robust XML parser if needed.
 * For now, it satisfies the "Parse Don't Validate" principle by
 * parsing into typed structures via Effect Schema.
 */
function extractElements(xml: string, tagName: string): string[] {
  const regex = new RegExp(`<${tagName}>(.*?)<\/${tagName}>`, "gs");
  return Array.from(xml.matchAll(regex)).map((m) => m[1]);
}

function extractText(xml: string, tagName: string): string | undefined {
  const regex = new RegExp(`<${tagName}>(.*?)<\/${tagName}>`, "s");
  const match = xml.match(regex);
  return match ? match[1] : undefined;
}

/**
 * Parses a DeleteObjects request body.
 */
export const parseDeleteObjectsRequest = (body: string) =>
  Effect.gen(function* () {
    const objectXmls = extractElements(body, "Object");
    const objects = objectXmls.map((xml) => ({
      key: extractText(xml, "Key"),
      versionId: extractText(xml, "VersionId"),
    }));

    return yield* Schema.decodeUnknown(Schema.Array(DeleteObjectEntry))(objects)
      .pipe(
        Effect.mapError((e) => new MalformedXML({ message: String(e) })),
      );
  });

/**
 * Parses a CompleteMultipartUpload request body.
 */
export const parseCompleteMultipartUploadRequest = (body: string) =>
  Effect.gen(function* () {
    const partXmls = extractElements(body, "Part");
    const parts = partXmls.map((xml) => {
      const partNumberStr = extractText(xml, "PartNumber");
      return {
        partNumber: partNumberStr ? parseInt(partNumberStr) : undefined,
        etag: extractText(xml, "ETag")?.replace(/&quot;/g, '"'),
        checksumSHA256: extractText(xml, "ChecksumSHA256"),
        checksumSHA1: extractText(xml, "ChecksumSHA1"),
        checksumCRC32: extractText(xml, "ChecksumCRC32"),
        checksumCRC32C: extractText(xml, "ChecksumCRC32C"),
        checksumCRC64NVME: extractText(xml, "ChecksumCRC64NVME"),
      };
    });

    return yield* Schema.decodeUnknown(Schema.Array(CompleteMultipartPart))(
      parts,
    ).pipe(
      Effect.mapError((e) => new MalformedXML({ message: String(e) })),
    );
  });
