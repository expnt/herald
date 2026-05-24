import { HttpServerResponse } from "@effect/platform";
import { Context, Effect, Layer } from "effect";
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
  InvalidPart,
  InvalidPartOrder,
  InvalidRequest,
  type ListMultipartUploadsResult,
  type ListObjectsResult,
  type ListPartsResult,
  MalformedXML,
  MethodNotAllowed,
  type MultipartUploadResult,
  NoSuchBucket,
  NoSuchKey,
  NoSuchUpload,
  type ObjectAttributes,
  type OwnerInfo,
  RequestTimeTooSkewed,
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
  }
>() {}

export const makeS3Xml = Effect.sync(() => {
  const encode = (s: string) =>
    s.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

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
      } else if (err instanceof InvalidBucketName) {
        code = "InvalidBucketName";
        message = err.message;
        status = 400;
      } else if (err instanceof InvalidArgument) {
        code = "InvalidArgument";
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
      const bucketsXml = buckets.map((b) =>
        `<Bucket><Name>${b.name}</Name><CreationDate>${b.creationDate.toISOString()}</CreationDate></Bucket>`
      ).join("");

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
      const contentsXml = result.contents.map((c) =>
        `<Contents><Key>${
          encode(c.key)
        }</Key><LastModified>${c.lastModified.toISOString()}</LastModified><ETag>${c.etag}</ETag><Size>${c.size}</Size><StorageClass>${
          c.storageClass || "STANDARD"
        }</StorageClass>${
          c.owner
            ? `<Owner><ID>${c.owner.id}</ID><DisplayName>${c.owner.displayName}</DisplayName></Owner>`
            : ""
        }</Contents>`
      ).join("");

      const commonPrefixesXml = result.commonPrefixes.map((cp) =>
        `<CommonPrefixes><Prefix>${encode(cp.prefix)}</Prefix></CommonPrefixes>`
      ).join("");

      const isV2 = result.listType === 2;

      const xml = isV2
        ? `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${result.name}</Name><Prefix>${
          encode(result.prefix ?? "")
        }</Prefix><KeyCount>${
          result.keyCount ?? 0
        }</KeyCount><MaxKeys>${result.maxKeys}</MaxKeys><IsTruncated>${result.isTruncated}</IsTruncated>${
          result.continuationToken
            ? `<ContinuationToken>${
              encode(result.continuationToken)
            }</ContinuationToken>`
            : ""
        }${
          result.nextContinuationToken
            ? `<NextContinuationToken>${
              encode(result.nextContinuationToken)
            }</NextContinuationToken>`
            : ""
        }${
          result.startAfter
            ? `<StartAfter>${encode(result.startAfter)}</StartAfter>`
            : ""
        }${contentsXml}${commonPrefixesXml}</ListBucketResult>`
        : `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${result.name}</Name><Prefix>${
          encode(result.prefix ?? "")
        }</Prefix><Marker>${
          encode(result.marker ?? "")
        }</Marker><MaxKeys>${result.maxKeys}</MaxKeys><IsTruncated>${result.isTruncated}</IsTruncated>${
          result.nextMarker
            ? `<NextMarker>${encode(result.nextMarker)}</NextMarker>`
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
      const versionsXml = result.contents.map((c) => {
        const tag = c.isDeleteMarker ? "DeleteMarker" : "Version";
        return `<${tag}><Key>${encode(c.key)}</Key><VersionId>${
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
      }).join("");

      const commonPrefixesXml = result.commonPrefixes.map((cp) =>
        `<CommonPrefixes><Prefix>${encode(cp.prefix)}</Prefix></CommonPrefixes>`
      ).join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${result.name}</Name><Prefix>${
          encode(result.prefix ?? "")
        }</Prefix><KeyMarker>${
          encode(result.marker ?? "")
        }</KeyMarker><VersionIdMarker>${
          encode(result.continuationToken ?? "")
        }</VersionIdMarker><MaxKeys>${result.maxKeys}</MaxKeys><IsTruncated>${result.isTruncated}</IsTruncated>${
          result.nextMarker
            ? `<NextKeyMarker>${encode(result.nextMarker)}</NextKeyMarker>`
            : ""
        }${
          result.nextContinuationToken
            ? `<NextVersionIdMarker>${
              encode(result.nextContinuationToken)
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
      const partsXml = result.parts.map((p) =>
        `<Part><PartNumber>${p.partNumber}</PartNumber>${
          p.lastModified !== undefined
            ? `<LastModified>${p.lastModified.toISOString()}</LastModified>`
            : ""
        }<ETag>${p.etag}</ETag><Size>${p.size}</Size></Part>`
      ).join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${result.bucket}</Bucket><Key>${
          encode(result.key)
        }</Key><UploadId>${result.uploadId}</UploadId><Initiator><ID>${result.initiator.id}</ID><DisplayName>${result.initiator.displayName}</DisplayName></Initiator><Owner><ID>${result.owner.id}</ID><DisplayName>${result.owner.displayName}</DisplayName></Owner><StorageClass>${result.storageClass}</StorageClass><PartNumberMarker>${result.partNumberMarker}</PartNumberMarker><NextPartNumberMarker>${result.nextPartNumberMarker}</NextPartNumberMarker><MaxParts>${result.maxParts}</MaxParts><IsTruncated>${result.isTruncated}</IsTruncated>${partsXml}</ListPartsResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },

    formatListMultipartUploads: (
      result: ListMultipartUploadsResult,
    ) => {
      const uploadsXml = result.uploads.map((u) =>
        `<Upload><Key>${
          encode(u.key)
        }</Key><UploadId>${u.uploadId}</UploadId><Initiator><ID>${u.initiator.id}</ID><DisplayName>${u.initiator.displayName}</DisplayName></Initiator><Owner><ID>${u.owner.id}</ID><DisplayName>${u.owner.displayName}</DisplayName></Owner><StorageClass>${u.storageClass}</StorageClass><Initiated>${u.initiated.toISOString()}</Initiated></Upload>`
      ).join("");

      const commonPrefixesXml = result.commonPrefixes.map((cp) =>
        `<CommonPrefixes><Prefix>${encode(cp.prefix)}</Prefix></CommonPrefixes>`
      ).join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${result.bucket}</Bucket><KeyMarker>${
          encode(result.keyMarker ?? "")
        }</KeyMarker><UploadIdMarker>${
          encode(result.uploadIdMarker ?? "")
        }</UploadIdMarker><NextKeyMarker>${
          encode(result.nextKeyMarker ?? "")
        }</NextKeyMarker><NextUploadIdMarker>${
          encode(result.nextUploadIdMarker ?? "")
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
          encode(key)
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
    formatCompleteMultipartUpload: (
      result: CompleteMultipartUploadResult,
    ) => {
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
          encode(result.key)
        }</Key><ETag>${result.etag}</ETag>${checksumAlgorithmXml}${checksumTypeXml}${checksumCRC32Xml}${checksumCRC32CXml}${checksumCRC64NVMEXml}${checksumSHA1Xml}${checksumSHA256Xml}</CompleteMultipartUploadResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },
    formatDeleteObjects: (result: DeleteObjectsResult) => {
      const deletedXml = result.deleted.map((k) =>
        `<Deleted><Key>${encode(k)}</Key></Deleted>`
      ).join("");
      const errorsXml = result.errors.map((e) =>
        `<Error><Key>${encode(e.key)}</Key><Code>${e.code}</Code><Message>${
          encode(e.message)
        }</Message></Error>`
      ).join("");

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
          encode(args.location)
        }</Location><Bucket>${encode(args.bucket)}</Bucket><Key>${
          encode(args.key)
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
          encode(args.etag)
        }</ETag><LastModified>${args.lastModified.toISOString()}</LastModified></CopyObjectResult>`;
      return HttpServerResponse.text(xml, {
        status: 200,
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(new TextEncoder().encode(xml).length),
        },
      });
    },

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
          (result.objectParts.parts ?? []).map((p) =>
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
            }</Part>`
          ).join("")
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
