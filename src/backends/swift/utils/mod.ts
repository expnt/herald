import * as xml2js from "xml2js";

export function formatRFC3339Date(dateString: string): string {
  // Convert the string into a Date object
  const date = new Date(dateString);

  // Format the date as an RFC-3339 string without microseconds
  return date.toISOString().replace(/(\.\d{3})\d+Z$/, "$1Z");
}

interface SwiftObject {
  name: string;
  last_modified: string;
  hash: string;
  bytes: number;
}

function getS3Object(item: SwiftObject) {
  return {
    Key: item.name,
    LastModified: formatRFC3339Date(item.last_modified),
    ETag: item.hash,
    Size: item.bytes,
    StorageClass: "STANDARD",
  };
}

function getS3Part(item: SwiftObject) {
  return {
    PartNumber: parseInt(item.name.substring(item.name.lastIndexOf("/") + 1)),
    LastModified: formatRFC3339Date(item.last_modified),
    ETag: item.hash,
    Size: item.bytes,
    StorageClass: "STANDARD",
  };
}

interface Folder {
  subdir: string;
}

function instanceOfFolder(object: object): object is Folder {
  return "subdir" in object;
}

function extractCommonPrefixes(folders: object[]): string[] {
  const prefixes = new Set<string>();

  for (const folder of folders) {
    if (!instanceOfFolder(folder)) {
      continue;
    }
    const dir = folder.subdir;
    prefixes.add(dir);
  }

  return Array.from(prefixes);
}

export async function toS3XmlContent(
  swiftResponse: Response,
  bucket: string,
  delimiter: string | null,
  prefix: string | null,
  maxKeys = 1000,
  continuationToken: string | null,
  encodingType: string | null = null,
  startAfter: string | null = null,
): Promise<Response> {
  const swiftStatus = swiftResponse.status;
  const swiftHeaders = swiftResponse.headers;

  // Handle 404 (NoSuchBucket) properly
  if (swiftStatus === 404) {
    const requestId = swiftHeaders.get("x-openstack-request-id") ||
      swiftHeaders.get("x-trans-id") || "Unknown";

    const s3ErrorXml = `
<Error>
  <Code>NoSuchBucket</Code>
  <Message>The specified bucket does not exist.</Message>
  <RequestId>${requestId}</RequestId>
  <HostId>swift-mapped-to-s3</HostId>
</Error>`.trim();

    return new Response(s3ErrorXml, {
      status: 404,
      headers: new Headers({
        "Content-Type": "application/xml",
      }),
    });
  }

  const swiftBody = await swiftResponse.json();

  const contents = [];
  for (const item of swiftBody) {
    // FIXME: skip the hidden folder which holds the herald state
    if (!item.name) {
      continue;
    }
    contents.push(getS3Object(item));
  }

  const commonPrefixes = delimiter ? extractCommonPrefixes(swiftBody) : [];

  const isTruncated = contents.length === maxKeys;
  const nextContinuationToken = isTruncated
    ? contents[contents.length - 1]?.Key
    : undefined;

  // deno-lint-ignore no-explicit-any
  const listBucketResult: any = {
    ListBucketResult: {
      $: {
        xmlns: "http://s3.amazonaws.com/doc/2006-03-01/",
      },
      Name: bucket,
      Prefix: prefix || "",
      Delimiter: delimiter || "",
      MaxKeys: maxKeys,
      KeyCount: contents.length + commonPrefixes.length,
      IsTruncated: isTruncated.toString(), // must be "true" or "false" strings
      Contents: contents,
      CommonPrefixes: commonPrefixes.map((prefix) => ({
        Prefix: prefix,
      })),
    },
  };

  if (continuationToken) {
    listBucketResult.ListBucketResult.ContinuationToken = continuationToken;
  }

  if (nextContinuationToken) {
    listBucketResult.ListBucketResult.NextContinuationToken =
      nextContinuationToken;
  }

  if (encodingType) {
    listBucketResult.ListBucketResult.EncodingType = encodingType;
  }

  if (startAfter) {
    listBucketResult.ListBucketResult.StartAfter = startAfter;
  }

  const xmlBuilder = new xml2js.Builder({
    headless: false,
    xmldec: {
      version: "1.0",
      encoding: "UTF-8",
    },
    renderOpts: {
      pretty: true,
      indent: "  ",
      newline: "\n",
    },
  });

  const formattedXml = xmlBuilder.buildObject(listBucketResult);

  const s3ResponseHeaders = new Headers();
  const requestId = swiftHeaders.get("x-openstack-request-id") ||
    swiftHeaders.get("x-trans-id");
  if (requestId) {
    s3ResponseHeaders.set("x-amz-request-id", requestId);
  }

  return new Response(formattedXml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml",
    },
  });
}

export async function toS3ListPartXmlContent(
  swiftResponse: Response,
  bucket: string,
  object: string | null,
  uploadId: string | null,
  partNumberMarker: number | null,
  maxKeys: number | null,
): Promise<Response> {
  const swiftBody = await swiftResponse.json();

  // Transforming Swift's JSON response to S3's XML format
  const parts = [];
  for (const item of swiftBody) {
    if (!item.name || item.name.startsWith(".herald-state")) {
      continue;
    }
    parts.push(getS3Part(item));
  }

  maxKeys = maxKeys ?? parts.length;
  const s3FormattedBody = {
    ListPartsResult: {
      Bucket: bucket,
      Key: object ?? "",
      MaxParts: maxKeys,
      UploadId: uploadId,
      PartNumberMarker: partNumberMarker,
      NextPartNumberMarker: parts.length > 0
        ? parts[parts.length - 1].PartNumber
        : null,
      IsTruncated: swiftBody.length === maxKeys,
      Part: parts.map((part) => ({
        PartNumber: part.PartNumber,
        LastModified: part.LastModified,
        ETag: part.ETag,
        Size: part.Size,
      })),
    },
  };

  const xmlBuilder = new xml2js.Builder();
  const formattedXml = xmlBuilder.buildObject(s3FormattedBody);

  return new Response(formattedXml, {
    headers: {
      "Content-Type": "application/xml",
    },
  });
}
