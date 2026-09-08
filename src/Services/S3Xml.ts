import { HttpServerResponse } from "@effect/platform";
import { Context, Effect, Layer } from "effect";
import type { AccessControlPolicy, AclGrant, AclGrantee } from "./Backend.ts";
import {
  AccessDenied,
  BadDigest,
  BadGateway,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  type BucketInfo,
  BucketNotEmpty,
  type CompleteMultipartUploadResult,
  DeleteObjectsError,
  type DeleteObjectsResult,
  EntityTooSmall,
  InternalError,
  InvalidAccessKeyId,
  InvalidArgument,
  InvalidBucketName,
  InvalidDigest,
  InvalidPart,
  InvalidPartOrder,
  InvalidRequest,
  type ListMultipartUploadsResult,
  type ListObjectsResult,
  type ListPartsResult,
  MalformedXML,
  MethodNotAllowed,
  MissingContentLength,
  type MultipartUploadResult,
  NoSuchBucket,
  NoSuchKey,
  NoSuchUpload,
  NotImplemented,
  type ObjectAttributes,
  type OwnerInfo,
  PreconditionFailed,
  RequestTimeTooSkewed,
  UnresolvableGrantByEmailAddress,
} from "./Backend.ts";

export class S3Xml extends Context.Tag("S3Xml")<
  S3Xml,
  {
    formatError: (
      err: unknown,
      isHead?: boolean,
    ) => HttpServerResponse.HttpServerResponse;
    formatListBuckets: (
      buckets: readonly BucketInfo[],
      owner: OwnerInfo,
    ) => HttpServerResponse.HttpServerResponse;
    formatListObjects: (
      result: ListObjectsResult,
    ) => HttpServerResponse.HttpServerResponse;
    formatListVersions: (
      result: ListObjectsResult,
    ) => HttpServerResponse.HttpServerResponse;
    formatListParts: (
      result: ListPartsResult,
    ) => HttpServerResponse.HttpServerResponse;
    formatListMultipartUploads: (
      result: ListMultipartUploadsResult,
    ) => HttpServerResponse.HttpServerResponse;
    formatInitiateMultipartUpload: (
      bucket: string,
      key: string,
      result: MultipartUploadResult,
    ) => HttpServerResponse.HttpServerResponse;
    formatCompleteMultipartUpload: (
      result: CompleteMultipartUploadResult,
    ) => HttpServerResponse.HttpServerResponse;
    formatObjectAttributes: (
      result: ObjectAttributes,
    ) => HttpServerResponse.HttpServerResponse;
    formatDeleteObjects: (
      result: DeleteObjectsResult,
    ) => HttpServerResponse.HttpServerResponse;
    formatPostResponse: (args: {
      location: string;
      bucket: string;
      key: string;
      etag: string;
    }) => HttpServerResponse.HttpServerResponse;
    formatCopyObjectResult: (args: {
      etag: string;
      lastModified: Date;
    }) => HttpServerResponse.HttpServerResponse;
    formatVersioning: (args: {
      status?: "Enabled" | "Suspended";
    }) => HttpServerResponse.HttpServerResponse;
    formatAccessControlPolicy: (
      policy: AccessControlPolicy,
    ) => HttpServerResponse.HttpServerResponse;
    parseAccessControlPolicy: (
      body: string,
    ) => Effect.Effect<AccessControlPolicy, MalformedXML>;
  }
>() {}

export const makeS3Xml = Effect.sync(() => {
  const encode = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
      // Escape control characters as numeric references: S3 echoes request
      // values like delimiters verbatim, and a raw control char in XML text
      // gets normalized away by lenient parsers (e.g. whitespace-only text
      // nodes are trimmed), breaking the echo. Real S3 emits &#xHH; too.
      // Escape control characters as numeric references: S3 echoes request
      // values like delimiters verbatim, and a raw control char in XML text
      // gets normalized away by lenient parsers (e.g. whitespace-only text
      // nodes are trimmed), breaking the echo. Real S3 emits &#xHH; too.
      // Hand-rolled scan instead of a RegExp so no-control-regex stays quiet:
      // matching control characters to escape them is the point of this code.
      .replace(
        // deno-lint-ignore no-control-regex
        /[\u0000-\u001F\u007F]/g,
        (c) =>
          `&#x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")};`,
      );

  /**
   * Percent-encodes a string the way S3 does for encoding-type=url responses:
   * every byte outside the unreserved set (A-Za-z0-9-._~) plus "/" is emitted
   * as %HH. This matches urllib.parse.quote(key, safe="/") which S3 uses, so
   * botocore's unquote round-trips keys, prefixes, and echo values exactly.
   */
  const urlEncode = (s: string) => {
    let out = "";
    for (const ch of s) {
      const code = ch.codePointAt(0);
      if (code === undefined) continue;
      if (
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x30 && code <= 0x39) ||
        ch === "-" ||
        ch === "." ||
        ch === "_" ||
        ch === "~" ||
        ch === "/"
      ) {
        out += ch;
      } else {
        for (const byte of new TextEncoder().encode(ch)) {
          out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        }
      }
    }
    return out;
  };

  const decodeEntities = (s: string) =>
    s.replace(
      /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g,
      (
        _m,
        hex: string | undefined,
        dec: string | undefined,
        named: string | undefined,
      ) => {
        if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
        if (dec !== undefined) return String.fromCodePoint(parseInt(dec, 10));
        switch (named) {
          case "amp":
            return "&";
          case "lt":
            return "<";
          case "gt":
            return ">";
          case "quot":
            return '"';
          case "apos":
            return "'";
          default:
            return _m;
        }
      },
    );

  const extractText = (xml: string, tagName: string): string | undefined => {
    // Allow attributes on the open tag (e.g. <Grantee xsi:type="...">);
    // without this, ACL grantee elements fail to match and grants collapse.
    const regex = new RegExp(
      `<${tagName}(?:\\s[^>]*)?>(.*?)<\\/${tagName}>`,
      "s",
    );
    const match = xml.match(regex);
    return match ? decodeEntities(match[1]) : undefined;
  };

  const extractElements = (xml: string, tagName: string): string[] => {
    const regex = new RegExp(
      `<${tagName}(?:\\s[^>]*)?>(.*?)<\\/${tagName}>`,
      "gs",
    );
    return Array.from(xml.matchAll(regex)).map((m) => m[1]);
  };

  // extractElements/extractText return only the content BETWEEN tags, so the
  // xsi:type attribute (which lives on the open tag) must be read from the
  // grant XML itself, not from the extracted inner content.
  const parseGranteeType = (grantXml: string): AclGrantee["type"] => {
    const openTag = grantXml.match(/<Grantee\b[^>]*>/)?.[0] ?? "";
    const typeMatch = openTag.match(/xsi:type="([^"]+)"/);
    const type = typeMatch ? typeMatch[1] : undefined;
    if (type === "Group") return "Group";
    if (type === "AmazonCustomerByEmail") return "AmazonCustomerByEmail";
    return "CanonicalUser";
  };

  const parseGrant = (grantXml: string): AclGrant => {
    const granteeXml = extractElements(grantXml, "Grantee")[0] ?? "";
    const permission = extractText(grantXml, "Permission") ?? "READ";
    const grantee: AclGrantee = {
      type: parseGranteeType(grantXml),
      id: extractText(granteeXml, "ID"),
      displayName: extractText(granteeXml, "DisplayName"),
      uri: extractText(granteeXml, "URI"),
      emailAddress: extractText(granteeXml, "EmailAddress"),
    };
    return { grantee, permission: permission as AclGrant["permission"] };
  };

  const parseAccessControlPolicyBody = (
    body: string,
  ): Effect.Effect<AccessControlPolicy, MalformedXML> =>
    Effect.gen(function* () {
      const ownerXml = extractElements(body, "Owner")[0] ?? "";
      const ownerId = extractText(ownerXml, "ID");
      const ownerDisplayName = extractText(ownerXml, "DisplayName");
      if (ownerId === undefined) {
        return yield* Effect.fail(
          new MalformedXML({
            message:
              "The XML you provided was not well-formed or did not validate against our published schema.",
          }),
        );
      }
      const aclXml = extractElements(body, "AccessControlList")[0] ?? "";
      const grants = extractElements(aclXml, "Grant").map(parseGrant);
      return {
        owner: {
          id: ownerId,
          displayName: ownerDisplayName ?? ownerId,
        },
        grants,
      } satisfies AccessControlPolicy;
    });

  return S3Xml.of({
    formatError: (err: unknown, isHead = false) => {
      let code = "InternalError";
      let message = "An internal error occurred.";
      let status = 500;

      if (err instanceof NoSuchBucket) {
        // For HEAD requests, S3 returns NotFound instead of NoSuchBucket
        code = isHead ? "NotFound" : "NoSuchBucket";
        message = err.message;
        status = 404;
      } else if (err instanceof NoSuchKey) {
        code = "NoSuchKey";
        message = err.message;
        status = 404;
      } else if (err instanceof BucketAlreadyExists) {
        code = "BucketAlreadyExists";
        message = err.message;
        status = 409;
      } else if (err instanceof BucketAlreadyOwnedByYou) {
        code = "BucketAlreadyOwnedByYou";
        message = err.message;
        status = 409;
      } else if (err instanceof InternalError) {
        code = "InternalError";
        message = err.message;
        status = 500;
      } else if (err instanceof AccessDenied) {
        code = "AccessDenied";
        message = err.message;
        status = 403;
      } else if (err instanceof InvalidAccessKeyId) {
        code = "InvalidAccessKeyId";
        message = err.message;
        status = 403;
      } else if (err instanceof BadGateway) {
        code = "BadGateway";
        message = err.message;
        status = 502;
      } else if (err instanceof BucketNotEmpty) {
        code = "BucketNotEmpty";
        message = err.message;
        status = 409;
      } else if (err instanceof NoSuchUpload) {
        code = "NoSuchUpload";
        message = err.message;
        status = 404;
      } else if (err instanceof InvalidPart) {
        code = "InvalidPart";
        message = err.message;
        status = 400;
      } else if (err instanceof InvalidPartOrder) {
        code = "InvalidPartOrder";
        message = err.message;
        status = 400;
      } else if (err instanceof EntityTooSmall) {
        code = "EntityTooSmall";
        message = err.message;
        status = 400;
      } else if (err instanceof InvalidRequest) {
        code = "InvalidRequest";
        message = err.message;
        status = 400;
      } else if (err instanceof BadDigest) {
        code = "BadDigest";
        message = err.message;
        status = 400;
      } else if (err instanceof InvalidDigest) {
        code = "InvalidDigest";
        message = err.message;
        status = 400;
      } else if (err instanceof MissingContentLength) {
        code = "MissingContentLength";
        message = err.message;
        status = 411;
      } else if (err instanceof InvalidBucketName) {
        code = "InvalidBucketName";
        message = err.message;
        status = 400;
      } else if (err instanceof InvalidArgument) {
        code = "InvalidArgument";
        message = err.message;
        status = 400;
      } else if (err instanceof UnresolvableGrantByEmailAddress) {
        code = "UnresolvableGrantByEmailAddress";
        message = err.message;
        status = 400;
      } else if (err instanceof RequestTimeTooSkewed) {
        code = "RequestTimeTooSkewed";
        message = err.message;
        status = 403;
      } else if (err instanceof MalformedXML) {
        code = "MalformedXML";
        message = err.message;
        status = 400;
      } else if (err instanceof MethodNotAllowed) {
        code = "MethodNotAllowed";
        message = err.message;
        status = 405;
      } else if (err instanceof NotImplemented) {
        code = "NotImplemented";
        message = err.message;
        status = 501;
      } else if (err instanceof PreconditionFailed) {
        code = "PreconditionFailed";
        message = err.message;
        status = 412;
      } else if (err instanceof DeleteObjectsError) {
        // Multi-object delete errors are returned in the body, but the response status is 200
        // Wait, S3 documentation says 200 OK even if some deletes fail.
        // But if the request is malformed, it's 400.
        // For now, we'll return 200 and format the errors in the body.
        status = 200;
      }

      if (isHead) {
        return HttpServerResponse.empty({ status });
      }

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
      return HttpServerResponse.text(xml, {
        status,
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },

    formatListBuckets: (buckets: readonly BucketInfo[], owner: OwnerInfo) => {
      const bucketsXml = buckets
        .map(
          (b) =>
            `<Bucket><Name>${b.name}</Name><CreationDate>${b.creationDate.toISOString()}</CreationDate></Bucket>`,
        )
        .join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>${owner.id}</ID><DisplayName>${owner.displayName}</DisplayName></Owner><Buckets>${bucketsXml}</Buckets></ListAllMyBucketsResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },

    formatListObjects: (result: ListObjectsResult) => {
      const urlEncoding = result.encodingType === "url";
      const enc = (s: string) => (urlEncoding ? urlEncode(s) : encode(s));

      const contentsXml = result.contents
        .map(
          (c) =>
            `<Contents><Key>${
              enc(
                c.key,
              )
            }</Key><LastModified>${c.lastModified.toISOString()}</LastModified><ETag>${c.etag}</ETag><Size>${c.size}</Size><StorageClass>${
              c.storageClass || "STANDARD"
            }</StorageClass>${
              c.owner
                ? `<Owner><ID>${c.owner.id}</ID><DisplayName>${c.owner.displayName}</DisplayName></Owner>`
                : ""
            }</Contents>`,
        )
        .join("");

      const commonPrefixesXml = result.commonPrefixes
        .map(
          (cp) =>
            `<CommonPrefixes><Prefix>${
              enc(cp.prefix)
            }</Prefix></CommonPrefixes>`,
        )
        .join("");

      const isV2 = result.listType === 2;

      const xml = isV2
        ? `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${result.name}</Name><Prefix>${
          enc(
            result.prefix ?? "",
          )
        }</Prefix>${
          result.delimiter !== undefined
            ? `<Delimiter>${enc(result.delimiter)}</Delimiter>`
            : ""
        }${urlEncoding ? "<EncodingType>url</EncodingType>" : ""}<KeyCount>${
          result.keyCount ?? 0
        }</KeyCount><MaxKeys>${result.maxKeys}</MaxKeys><IsTruncated>${result.isTruncated}</IsTruncated>${
          result.continuationToken !== undefined
            ? `<ContinuationToken>${
              encode(
                result.continuationToken,
              )
            }</ContinuationToken>`
            : ""
        }${
          result.nextContinuationToken
            ? `<NextContinuationToken>${
              encode(
                result.nextContinuationToken,
              )
            }</NextContinuationToken>`
            : ""
        }${
          result.startAfter !== undefined
            ? `<StartAfter>${enc(result.startAfter)}</StartAfter>`
            : ""
        }${contentsXml}${commonPrefixesXml}</ListBucketResult>`
        : `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${result.name}</Name><Prefix>${
          enc(
            result.prefix ?? "",
          )
        }</Prefix>${
          result.delimiter !== undefined
            ? `<Delimiter>${enc(result.delimiter)}</Delimiter>`
            : ""
        }${urlEncoding ? "<EncodingType>url</EncodingType>" : ""}<Marker>${
          enc(
            result.marker ?? "",
          )
        }</Marker><MaxKeys>${result.maxKeys}</MaxKeys><IsTruncated>${result.isTruncated}</IsTruncated>${
          result.nextMarker
            ? `<NextMarker>${enc(result.nextMarker)}</NextMarker>`
            : ""
        }${contentsXml}${commonPrefixesXml}</ListBucketResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },

    formatListVersions: (result: ListObjectsResult) => {
      const urlEncoding = result.encodingType === "url";
      const enc = (s: string) => (urlEncoding ? urlEncode(s) : encode(s));

      const versionsXml = result.contents
        .map((c) => {
          const tag = c.isDeleteMarker ? "DeleteMarker" : "Version";
          return `<${tag}><Key>${enc(c.key)}</Key><VersionId>${
            c.versionId || "null"
          }</VersionId><IsLatest>${
            c.isLatest || false
          }</IsLatest><LastModified>${c.lastModified.toISOString()}</LastModified><ETag>${c.etag}</ETag><Size>${c.size}</Size><StorageClass>${
            c.storageClass || "STANDARD"
          }</StorageClass>${
            c.owner
              ? `<Owner><ID>${c.owner.id}</ID><DisplayName>${c.owner.displayName}</DisplayName></Owner>`
              : ""
          }</${tag}>`;
        })
        .join("");

      const commonPrefixesXml = result.commonPrefixes
        .map(
          (cp) =>
            `<CommonPrefixes><Prefix>${
              enc(cp.prefix)
            }</Prefix></CommonPrefixes>`,
        )
        .join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${result.name}</Name><Prefix>${
          enc(
            result.prefix ?? "",
          )
        }</Prefix>${
          result.delimiter !== undefined
            ? `<Delimiter>${enc(result.delimiter)}</Delimiter>`
            : ""
        }${urlEncoding ? "<EncodingType>url</EncodingType>" : ""}<KeyMarker>${
          enc(
            result.marker ?? "",
          )
        }</KeyMarker><VersionIdMarker>${
          encode(
            result.continuationToken ?? "",
          )
        }</VersionIdMarker><MaxKeys>${result.maxKeys}</MaxKeys><IsTruncated>${result.isTruncated}</IsTruncated>${
          result.nextMarker
            ? `<NextKeyMarker>${enc(result.nextMarker)}</NextKeyMarker>`
            : ""
        }${
          result.nextContinuationToken
            ? `<NextVersionIdMarker>${
              encode(
                result.nextContinuationToken,
              )
            }</NextVersionIdMarker>`
            : ""
        }${versionsXml}${commonPrefixesXml}</ListVersionsResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },

    formatListParts: (result: ListPartsResult) => {
      const partsXml = result.parts
        .map(
          (p) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber>${
              p.lastModified !== undefined
                ? `<LastModified>${p.lastModified.toISOString()}</LastModified>`
                : ""
            }<ETag>${p.etag}</ETag><Size>${p.size}</Size></Part>`,
        )
        .join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${result.bucket}</Bucket><Key>${
          encode(
            result.key,
          )
        }</Key><UploadId>${result.uploadId}</UploadId><Initiator><ID>${result.initiator.id}</ID><DisplayName>${result.initiator.displayName}</DisplayName></Initiator><Owner><ID>${result.owner.id}</ID><DisplayName>${result.owner.displayName}</DisplayName></Owner><StorageClass>${result.storageClass}</StorageClass><PartNumberMarker>${result.partNumberMarker}</PartNumberMarker><NextPartNumberMarker>${result.nextPartNumberMarker}</NextPartNumberMarker><MaxParts>${result.maxParts}</MaxParts><IsTruncated>${result.isTruncated}</IsTruncated>${partsXml}</ListPartsResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },

    formatListMultipartUploads: (result: ListMultipartUploadsResult) => {
      const uploadsXml = result.uploads
        .map(
          (u) =>
            `<Upload><Key>${
              encode(
                u.key,
              )
            }</Key><UploadId>${u.uploadId}</UploadId><Initiator><ID>${u.initiator.id}</ID><DisplayName>${u.initiator.displayName}</DisplayName></Initiator><Owner><ID>${u.owner.id}</ID><DisplayName>${u.owner.displayName}</DisplayName></Owner><StorageClass>${u.storageClass}</StorageClass><Initiated>${u.initiated.toISOString()}</Initiated></Upload>`,
        )
        .join("");

      const commonPrefixesXml = result.commonPrefixes
        .map(
          (cp) =>
            `<CommonPrefixes><Prefix>${
              encode(cp.prefix)
            }</Prefix></CommonPrefixes>`,
        )
        .join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${result.bucket}</Bucket><KeyMarker>${
          encode(
            result.keyMarker ?? "",
          )
        }</KeyMarker><UploadIdMarker>${
          encode(
            result.uploadIdMarker ?? "",
          )
        }</UploadIdMarker><NextKeyMarker>${
          encode(
            result.nextKeyMarker ?? "",
          )
        }</NextKeyMarker><NextUploadIdMarker>${
          encode(
            result.nextUploadIdMarker ?? "",
          )
        }</NextUploadIdMarker><MaxUploads>${result.maxUploads}</MaxUploads><IsTruncated>${result.isTruncated}</IsTruncated>${uploadsXml}${commonPrefixesXml}</ListMultipartUploadsResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },
    formatInitiateMultipartUpload: (
      bucket: string,
      key: string,
      result: MultipartUploadResult,
    ) => {
      const checksumAlgorithmXml = result.checksumAlgorithm
        ? `<ChecksumAlgorithm>${result.checksumAlgorithm.toUpperCase()}</ChecksumAlgorithm>`
        : "";
      const checksumTypeXml = result.checksumType
        ? `<ChecksumType>${result.checksumType.toUpperCase()}</ChecksumType>`
        : "";
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${bucket}</Bucket><Key>${
          encode(
            key,
          )
        }</Key><UploadId>${result.uploadId}</UploadId>${checksumAlgorithmXml}${checksumTypeXml}</InitiateMultipartUploadResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
          ...(result.checksumAlgorithm
            ? {
              "x-amz-checksum-algorithm": result.checksumAlgorithm
                .toUpperCase(),
            }
            : {}),
          ...(result.checksumType
            ? { "x-amz-checksum-type": result.checksumType.toUpperCase() }
            : {}),
        },
      });
    },
    formatCompleteMultipartUpload: (result: CompleteMultipartUploadResult) => {
      const checksumAlgorithmXml = result.checksumAlgorithm
        ? `<ChecksumAlgorithm>${result.checksumAlgorithm.toUpperCase()}</ChecksumAlgorithm>`
        : "";
      const checksumTypeXml = result.checksumType
        ? `<ChecksumType>${result.checksumType.toUpperCase()}</ChecksumType>`
        : "";
      const checksumCRC32Xml = result.checksumCRC32
        ? `<ChecksumCRC32>${result.checksumCRC32}</ChecksumCRC32>`
        : "";
      const checksumCRC32CXml = result.checksumCRC32C
        ? `<ChecksumCRC32C>${result.checksumCRC32C}</ChecksumCRC32C>`
        : "";
      const checksumCRC64NVMEXml = result.checksumCRC64NVME
        ? `<ChecksumCRC64NVME>${result.checksumCRC64NVME}</ChecksumCRC64NVME>`
        : "";
      const checksumSHA1Xml = result.checksumSHA1
        ? `<ChecksumSHA1>${result.checksumSHA1}</ChecksumSHA1>`
        : "";
      const checksumSHA256Xml = result.checksumSHA256
        ? `<ChecksumSHA256>${result.checksumSHA256}</ChecksumSHA256>`
        : "";

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>${result.location}</Location><Bucket>${result.bucket}</Bucket><Key>${
          encode(
            result.key,
          )
        }</Key><ETag>${result.etag}</ETag>${checksumAlgorithmXml}${checksumTypeXml}${checksumCRC32Xml}${checksumCRC32CXml}${checksumCRC64NVMEXml}${checksumSHA1Xml}${checksumSHA256Xml}</CompleteMultipartUploadResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },
    formatDeleteObjects: (result: DeleteObjectsResult) => {
      const deletedXml = result.deleted
        .map((k) => `<Deleted><Key>${encode(k)}</Key></Deleted>`)
        .join("");
      const errorsXml = result.errors
        .map(
          (e) =>
            `<Error><Key>${encode(e.key)}</Key><Code>${e.code}</Code><Message>${
              encode(
                e.message,
              )
            }</Message></Error>`,
        )
        .join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deletedXml}${errorsXml}</DeleteResult>`;
      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },

    formatPostResponse: (args) => {
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><PostResponse xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>${
          encode(
            args.location,
          )
        }</Location><Bucket>${encode(args.bucket)}</Bucket><Key>${
          encode(
            args.key,
          )
        }</Key><ETag>${encode(args.etag)}</ETag></PostResponse>`;
      return HttpServerResponse.text(xml, {
        status: 201,
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },

    formatCopyObjectResult: (args) => {
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ETag>${
          encode(
            args.etag,
          )
        }</ETag><LastModified>${args.lastModified.toISOString()}</LastModified></CopyObjectResult>`;
      return HttpServerResponse.text(xml, {
        status: 200,
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },

    formatVersioning: (args) => {
      const statusXml = args.status ? `<Status>${args.status}</Status>` : "";
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${statusXml}</VersioningConfiguration>`;
      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },

    formatAccessControlPolicy: (policy) => {
      const ownerXml = `<Owner><ID>${
        encode(policy.owner.id)
      }</ID><DisplayName>${
        encode(policy.owner.displayName)
      }</DisplayName></Owner>`;
      const grantsXml = policy.grants
        .map((grant) => {
          const g = grant.grantee;
          let granteeXml: string;
          if (g.type === "Group") {
            granteeXml =
              `<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group">${
                g.uri ? `<URI>${encode(g.uri)}</URI>` : ""
              }</Grantee>`;
          } else if (g.type === "AmazonCustomerByEmail") {
            granteeXml =
              `<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="AmazonCustomerByEmail">${
                g.emailAddress
                  ? `<EmailAddress>${encode(g.emailAddress)}</EmailAddress>`
                  : ""
              }</Grantee>`;
          } else {
            granteeXml =
              `<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser">${
                g.id ? `<ID>${encode(g.id)}</ID>` : ""
              }${
                // CanonicalUser responses must always carry DisplayName:
                // s3-tests' check_grants sorts grants by it and crashes on
                // None when a stored grant (e.g. written via a grant header
                // with only an ID) lacks one. Herald's display name equals
                // the access key id, so fall back to the id itself.
                (g.displayName ?? g.id)
                  ? `<DisplayName>${
                    encode(g.displayName ?? g.id!)
                  }</DisplayName>`
                  : ""}</Grantee>`;
          }
          return `<Grant>${granteeXml}<Permission>${grant.permission}</Permission></Grant>`;
        })
        .join("");
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${ownerXml}<AccessControlList>${grantsXml}</AccessControlList></AccessControlPolicy>`;
      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },

    parseAccessControlPolicy: (body) => parseAccessControlPolicyBody(body),

    formatObjectAttributes: (result: ObjectAttributes) => {
      const checksumXml = result.checksum
        ? `<Checksum>${
          result.checksum.checksumAlgorithm
            ? `<ChecksumAlgorithm>${result.checksum.checksumAlgorithm.toUpperCase()}</ChecksumAlgorithm>`
            : ""
        }${
          result.checksum.checksumCRC32
            ? `<ChecksumCRC32>${result.checksum.checksumCRC32}</ChecksumCRC32>`
            : ""
        }${
          result.checksum.checksumCRC32C
            ? `<ChecksumCRC32C>${result.checksum.checksumCRC32C}</ChecksumCRC32C>`
            : ""
        }${
          result.checksum.checksumCRC64NVME
            ? `<ChecksumCRC64NVME>${result.checksum.checksumCRC64NVME}</ChecksumCRC64NVME>`
            : ""
        }${
          result.checksum.checksumSHA1
            ? `<ChecksumSHA1>${result.checksum.checksumSHA1}</ChecksumSHA1>`
            : ""
        }${
          result.checksum.checksumSHA256
            ? `<ChecksumSHA256>${result.checksum.checksumSHA256}</ChecksumSHA256>`
            : ""
        }</Checksum>`
        : "";

      const objectPartsXml = result.objectParts
        ? `<ObjectParts>${
          result.objectParts.totalPartsCount !== undefined
            ? `<TotalPartsCount>${result.objectParts.totalPartsCount}</TotalPartsCount>`
            : ""
        }${
          result.objectParts.partNumberMarker !== undefined
            ? `<PartNumberMarker>${result.objectParts.partNumberMarker}</PartNumberMarker>`
            : ""
        }${
          result.objectParts.nextPartNumberMarker !== undefined
            ? `<NextPartNumberMarker>${result.objectParts.nextPartNumberMarker}</NextPartNumberMarker>`
            : ""
        }${
          result.objectParts.maxParts !== undefined
            ? `<MaxParts>${result.objectParts.maxParts}</MaxParts>`
            : ""
        }${
          result.objectParts.isTruncated !== undefined
            ? `<IsTruncated>${result.objectParts.isTruncated}</IsTruncated>`
            : ""
        }${
          (result.objectParts.parts ?? [])
            .map(
              (p) =>
                `<Part><PartNumber>${p.partNumber}</PartNumber><Size>${p.size}</Size>${
                  p.checksumCRC32 !== undefined
                    ? `<ChecksumCRC32>${p.checksumCRC32}</ChecksumCRC32>`
                    : ""
                }${
                  p.checksumCRC32C !== undefined
                    ? `<ChecksumCRC32C>${p.checksumCRC32C}</ChecksumCRC32C>`
                    : ""
                }${
                  p.checksumSHA1 !== undefined
                    ? `<ChecksumSHA1>${p.checksumSHA1}</ChecksumSHA1>`
                    : ""
                }${
                  p.checksumSHA256 !== undefined
                    ? `<ChecksumSHA256>${p.checksumSHA256}</ChecksumSHA256>`
                    : ""
                }${
                  p.checksumCRC64NVME !== undefined
                    ? `<ChecksumCRC64NVME>${p.checksumCRC64NVME}</ChecksumCRC64NVME>`
                    : ""
                }</Part>`,
            )
            .join("")
        }</ObjectParts>`
        : "";

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><GetObjectAttributesResponse xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${
          result.etag ? `<ETag>${result.etag}</ETag>` : ""
        }${checksumXml}${objectPartsXml}${
          result.objectSize
            ? `<ObjectSize>${result.objectSize}</ObjectSize>`
            : ""
        }${
          result.storageClass
            ? `<StorageClass>${result.storageClass}</StorageClass>`
            : ""
        }</GetObjectAttributesResponse>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },
  });
});

export const S3XmlLive = Layer.effect(S3Xml, makeS3Xml);
