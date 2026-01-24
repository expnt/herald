import { Effect, Schema } from "effect";
import { ChecksumAlgorithm } from "../../src/Services/S3Schema.ts";
import { parseChecksumHeaders } from "../../src/Services/S3HeaderParser.ts";
import {
  parseCompleteMultipartUploadRequest,
  parseDeleteObjectsRequest,
} from "../../src/Services/XmlParser.ts";
import { assert, assertEquals } from "../utils.ts";

Deno.test("Schema Parsing / ChecksumAlgorithm", () => {
  const decode = Schema.decodeSync(ChecksumAlgorithm);
  assertEquals(decode("SHA256"), "SHA256");
  assertEquals(decode("CRC32"), "CRC32");
  // @ts-expect-error: Invalid literal
  assert(() => decode("INVALID"));
});

Deno.test("Schema Parsing / ChecksumHeaders", async () => {
  const headers = {
    "x-amz-checksum-algorithm": "sha256",
    "x-amz-checksum-sha256": "base64-value",
    "x-amz-checksum-type": "COMPOSITE",
  };

  const parsed = await Effect.runPromise(parseChecksumHeaders(headers));
  assertEquals(parsed.algorithm, "SHA256");
  assertEquals(parsed.sha256, "base64-value");
  assertEquals(parsed.type, "COMPOSITE");
});

Deno.test("Schema Parsing / DeleteObjects XML", async () => {
  const xml = `
    <Delete>
      <Object><Key>file1.txt</Key></Object>
      <Object><Key>file2.txt</Key><VersionId>v1</VersionId></Object>
    </Delete>
  `;

  const parsed = await Effect.runPromise(parseDeleteObjectsRequest(xml));
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0].key, "file1.txt");
  assertEquals(parsed[1].key, "file2.txt");
  assertEquals(parsed[1].versionId, "v1");
});

Deno.test("Schema Parsing / CompleteMultipartUpload XML", async () => {
  const xml = `
    <CompleteMultipartUpload>
      <Part>
        <PartNumber>1</PartNumber>
        <ETag>"etag1"</ETag>
        <ChecksumSHA256>sha1</ChecksumSHA256>
      </Part>
      <Part>
        <PartNumber>2</PartNumber>
        <ETag>"etag2"</ETag>
      </Part>
    </CompleteMultipartUpload>
  `;

  const parsed = await Effect.runPromise(
    parseCompleteMultipartUploadRequest(xml),
  );
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0].partNumber, 1);
  assertEquals(parsed[0].etag, '"etag1"');
  assertEquals(parsed[0].checksumSHA256, "sha1");
  assertEquals(parsed[1].partNumber, 2);
  assertEquals(parsed[1].etag, '"etag2"');
});
