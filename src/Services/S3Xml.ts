import { Context, Layer } from "effect";
import { HttpServerResponse } from "@effect/platform";
import {
  AccessDenied,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  type BucketInfo,
  BucketNotEmpty,
  EntityTooSmall,
  InternalError,
  InvalidPart,
  InvalidPartOrder,
  InvalidRequest,
  type ListMultipartUploadsResult,
  type ListObjectsResult,
  type ListPartsResult,
  MalformedXML,
  NoSuchBucket,
  NoSuchKey,
  NoSuchUpload,
  type ObjectAttributes,
  type OwnerInfo,
} from "./Backend.ts";

/**
 * This service centeralizes XML authoring logic.
 */
export class S3Xml extends Context.Tag("S3Xml")<
  S3Xml,
  {
    readonly formatError: (
      e: unknown,
      isHead?: boolean,
    ) => HttpServerResponse.HttpServerResponse;
    readonly formatListBuckets: (
      buckets: readonly BucketInfo[],
      owner: OwnerInfo,
    ) => HttpServerResponse.HttpServerResponse;
    readonly formatListObjects: (
      result: ListObjectsResult,
    ) => HttpServerResponse.HttpServerResponse;
    readonly formatListVersions: (
      result: ListObjectsResult,
    ) => HttpServerResponse.HttpServerResponse;
    readonly formatListMultipartUploads: (
      result: ListMultipartUploadsResult,
    ) => HttpServerResponse.HttpServerResponse;
    readonly formatInitiateMultipartUpload: (
      bucket: string,
      key: string,
      uploadId: string,
      checksumAlgorithm?: string,
    ) => HttpServerResponse.HttpServerResponse;
    readonly formatCompleteMultipartUpload: (
      result: {
        location: string;
        bucket: string;
        key: string;
        etag: string;
        checksumAlgorithm?: string;
        checksumCRC32?: string;
        checksumCRC32C?: string;
        checksumCRC64NVME?: string;
        checksumSHA1?: string;
        checksumSHA256?: string;
      },
    ) => HttpServerResponse.HttpServerResponse;
    readonly formatListParts: (
      result: ListPartsResult,
    ) => HttpServerResponse.HttpServerResponse;
    readonly formatObjectAttributes: (
      result: ObjectAttributes,
    ) => HttpServerResponse.HttpServerResponse;
  }
>() {}

export const S3XmlLive = Layer.succeed(
  S3Xml,
  S3Xml.of({
    formatError: (e, isHead = false) => {
      let code = "InternalError";
      let message = "An internal error occurred";
      let status = 500;

      if (e instanceof NoSuchBucket) {
        code = "NoSuchBucket";
        message = e.message;
        status = 404;
      } else if (e instanceof NoSuchKey) {
        // For HEAD requests, use "NotFound" instead of "NoSuchKey"
        code = isHead ? "NotFound" : "NoSuchKey";
        message = e.message;
        status = 404;
      } else if (e instanceof BucketAlreadyExists) {
        code = "BucketAlreadyExists";
        message = e.message;
        status = 409;
      } else if (e instanceof BucketAlreadyOwnedByYou) {
        code = "BucketAlreadyOwnedByYou";
        message = e.message;
        status = 409;
      } else if (e instanceof AccessDenied) {
        code = "AccessDenied";
        message = e.message;
        status = 403;
      } else if (e instanceof BucketNotEmpty) {
        code = "BucketNotEmpty";
        message = e.message;
        status = 409;
      } else if (e instanceof NoSuchUpload) {
        code = "NoSuchUpload";
        message = e.message;
        status = 404;
      } else if (e instanceof InvalidPart) {
        code = "InvalidPart";
        message = e.message;
        status = 400;
      } else if (e instanceof InvalidPartOrder) {
        code = "InvalidPartOrder";
        message = e.message;
        status = 400;
      } else if (e instanceof EntityTooSmall) {
        code = "EntityTooSmall";
        message = e.message;
        status = 400;
      } else if (e instanceof InvalidRequest) {
        code = "InvalidRequest";
        message = e.message;
        status = 400;
      } else if (e instanceof MalformedXML) {
        code = "MalformedXML";
        message = e.message;
        status = 400;
      } else if (e instanceof InternalError) {
        code = "InternalError";
        message = e.message;
        status = 500;
      } else if (e instanceof Error) {
        message = e.message;
      } else if (typeof e === "string") {
        message = e;
      }

      if (isHead) {
        return HttpServerResponse.raw(null, { status });
      }

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

      return HttpServerResponse.text(xml, {
        status,
        headers: {
          "Content-Type": "application/xml",
        },
      });
    },

    formatListBuckets: (buckets, owner) => {
      const bucketsXml = buckets.map((b) =>
        `<Bucket><Name>${b.name}</Name><CreationDate>${b.creationDate?.toISOString()}</CreationDate></Bucket>`
      ).join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>${owner.id}</ID><DisplayName>${owner.displayName}</DisplayName></Owner><Buckets>${bucketsXml}</Buckets></ListAllMyBucketsResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
        },
      });
    },

    formatListObjects: (result) => {
      const encode = (s: string) =>
        result.encodingType?.toLowerCase() === "url"
          ? encodeURIComponent(s).replace(/%2F/g, "/")
          : s;

      const contentsXml = result.contents.map((c) =>
        `<Contents><Key>${
          encode(c.key)
        }</Key><LastModified>${c.lastModified.toISOString()}</LastModified><ETag>${c.etag}</ETag><Size>${c.size}</Size><StorageClass>${
          c.storageClass ??
            "STANDARD"
        }</StorageClass>${
          c.owner
            ? `<Owner><ID>${c.owner.id}</ID><DisplayName>${c.owner.displayName}</DisplayName></Owner>`
            : ""
        }</Contents>`
      ).join("");

      const commonPrefixesXml = result.commonPrefixes.map((cp) =>
        `<CommonPrefixes><Prefix>${encode(cp.prefix)}</Prefix></CommonPrefixes>`
      ).join("");

      let xml: string;
      if (result.listType === 2) {
        // ListObjectsV2
        xml =
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${result.name}</Name><Prefix>${
            encode(
              result.prefix ?? "",
            )
          }</Prefix><KeyCount>${
            result.keyCount ??
              (result.contents.length + result.commonPrefixes.length)
          }</KeyCount><MaxKeys>${result.maxKeys}</MaxKeys><Delimiter>${
            encode(
              result.delimiter ?? "",
            )
          }</Delimiter><IsTruncated>${result.isTruncated}</IsTruncated>${
            result.continuationToken
              ? `<ContinuationToken>${result.continuationToken}</ContinuationToken>`
              : ""
          }${
            result.nextContinuationToken
              ? `<NextContinuationToken>${result.nextContinuationToken}</NextContinuationToken>`
              : ""
          }${
            result.startAfter
              ? `<StartAfter>${encode(result.startAfter)}</StartAfter>`
              : ""
          }${
            result.encodingType
              ? `<EncodingType>${result.encodingType}</EncodingType>`
              : ""
          }${contentsXml}${commonPrefixesXml}</ListBucketResult>`;
      } else {
        // ListObjectsV1
        xml =
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${result.name}</Name><Prefix>${
            encode(
              result.prefix ?? "",
            )
          }</Prefix><Marker>${encode(result.marker ?? "")}</Marker>${
            result.nextMarker
              ? `<NextMarker>${encode(result.nextMarker)}</NextMarker>`
              : ""
          }<MaxKeys>${result.maxKeys}</MaxKeys><Delimiter>${
            encode(
              result.delimiter ?? "",
            )
          }</Delimiter><IsTruncated>${result.isTruncated}</IsTruncated>${
            result.encodingType
              ? `<EncodingType>${result.encodingType}</EncodingType>`
              : ""
          }${contentsXml}${commonPrefixesXml}</ListBucketResult>`;
      }

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
        },
      });
    },

    formatListVersions: (result) => {
      const encode = (s: string) =>
        result.encodingType?.toLowerCase() === "url"
          ? encodeURIComponent(s).replace(/%2F/g, "/")
          : s;

      const versionsXml = result.contents.filter((c) => !c.isDeleteMarker).map(
        (v) =>
          `<Version><Key>${encode(v.key)}</Key><VersionId>${
            v.versionId ??
              "null"
          }</VersionId><IsLatest>${
            v.isLatest ??
              true
          }</IsLatest><LastModified>${v.lastModified.toISOString()}</LastModified><ETag>${v.etag}</ETag><Size>${v.size}</Size><StorageClass>${
            v.storageClass ??
              "STANDARD"
          }</StorageClass>${
            v.owner
              ? `<Owner><ID>${v.owner.id}</ID><DisplayName>${v.owner.displayName}</DisplayName></Owner>`
              : ""
          }</Version>`,
      ).join("");

      const deleteMarkersXml = result.contents.filter((c) => c.isDeleteMarker)
        .map((dm) =>
          `<DeleteMarker><Key>${encode(dm.key)}</Key><VersionId>${
            dm.versionId ??
              "null"
          }</VersionId><IsLatest>${
            dm.isLatest ??
              true
          }</IsLatest><LastModified>${dm.lastModified.toISOString()}</LastModified>${
            dm.owner
              ? `<Owner><ID>${dm.owner.id}</ID><DisplayName>${dm.owner.displayName}</DisplayName></Owner>`
              : ""
          }</DeleteMarker>`
        ).join("");

      const commonPrefixesXml = result.commonPrefixes.map((cp) =>
        `<CommonPrefixes><Prefix>${encode(cp.prefix)}</Prefix></CommonPrefixes>`
      ).join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${result.name}</Name><Prefix>${
          encode(
            result.prefix ?? "",
          )
        }</Prefix><KeyMarker>${
          encode(
            result.marker ?? "",
          )
        }</KeyMarker><VersionIdMarker></VersionIdMarker><MaxKeys>${result.maxKeys}</MaxKeys><Delimiter>${
          encode(
            result.delimiter ?? "",
          )
        }</Delimiter><IsTruncated>${result.isTruncated}</IsTruncated>${
          result.nextMarker
            ? `<NextKeyMarker>${
              encode(result.nextMarker)
            }</NextKeyMarker><NextVersionIdMarker>null</NextVersionIdMarker>`
            : ""
        }${versionsXml}${deleteMarkersXml}${commonPrefixesXml}</ListVersionsResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
        },
      });
    },

    formatListMultipartUploads: (result) => {
      const uploadsXml = result.uploads.map((u) =>
        `<Upload><Key>${u.key}</Key><UploadId>${u.uploadId}</UploadId><Initiator><ID>${u.initiator.id}</ID><DisplayName>${u.initiator.displayName}</DisplayName></Initiator><Owner><ID>${u.owner.id}</ID><DisplayName>${u.owner.displayName}</DisplayName></Owner><StorageClass>${u.storageClass}</StorageClass><Initiated>${u.initiated.toISOString()}</Initiated></Upload>`
      ).join("");

      const commonPrefixesXml = result.commonPrefixes.map((cp) =>
        `<CommonPrefixes><Prefix>${cp.prefix}</Prefix></CommonPrefixes>`
      ).join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${result.bucket}</Bucket><KeyMarker>${
          result.keyMarker ?? ""
        }</KeyMarker><UploadIdMarker>${
          result.uploadIdMarker ?? ""
        }</UploadIdMarker><NextKeyMarker>${
          result.nextKeyMarker ?? ""
        }</NextKeyMarker><NextUploadIdMarker>${
          result.nextUploadIdMarker ?? ""
        }</NextUploadIdMarker><MaxUploads>${result.maxUploads}</MaxUploads><IsTruncated>${result.isTruncated}</IsTruncated>${uploadsXml}${commonPrefixesXml}</ListMultipartUploadsResult>`;

      return HttpServerResponse.text(xml, {
        headers: { "Content-Type": "application/xml" },
      });
    },

    formatInitiateMultipartUpload: (
      bucket,
      key,
      uploadId,
      checksumAlgorithm,
    ) => {
      const checksumAlgorithmXml = checksumAlgorithm
        ? `<ChecksumAlgorithm>${checksumAlgorithm}</ChecksumAlgorithm>`
        : "";
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId>${checksumAlgorithmXml}</InitiateMultipartUploadResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
        },
      });
    },

    formatCompleteMultipartUpload: (result) => {
      const checksumAlgorithmXml = result.checksumAlgorithm
        ? `<ChecksumAlgorithm>${result.checksumAlgorithm}</ChecksumAlgorithm>`
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
        `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>${result.location}</Location><Bucket>${result.bucket}</Bucket><Key>${result.key}</Key><ETag>${result.etag}</ETag>${checksumAlgorithmXml}${checksumCRC32Xml}${checksumCRC32CXml}${checksumCRC64NVMEXml}${checksumSHA1Xml}${checksumSHA256Xml}</CompleteMultipartUploadResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
        },
      });
    },

    formatListParts: (result) => {
      const partsXml = result.parts.map((p) => {
        const checksumCRC32Xml = p.checksumCRC32
          ? `<ChecksumCRC32>${p.checksumCRC32}</ChecksumCRC32>`
          : "";
        const checksumCRC32CXml = p.checksumCRC32C
          ? `<ChecksumCRC32C>${p.checksumCRC32C}</ChecksumCRC32C>`
          : "";
        const checksumCRC64NVMEXml = p.checksumCRC64NVME
          ? `<ChecksumCRC64NVME>${p.checksumCRC64NVME}</ChecksumCRC64NVME>`
          : "";
        const checksumSHA1Xml = p.checksumSHA1
          ? `<ChecksumSHA1>${p.checksumSHA1}</ChecksumSHA1>`
          : "";
        const checksumSHA256Xml = p.checksumSHA256
          ? `<ChecksumSHA256>${p.checksumSHA256}</ChecksumSHA256>`
          : "";

        return `<Part><PartNumber>${p.partNumber}</PartNumber><LastModified>${p.lastModified.toISOString()}</LastModified><ETag>${p.etag}</ETag><Size>${p.size}</Size>${checksumCRC32Xml}${checksumCRC32CXml}${checksumCRC64NVMEXml}${checksumSHA1Xml}${checksumSHA256Xml}</Part>`;
      }).join("");

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${result.bucket}</Bucket><Key>${result.key}</Key><UploadId>${result.uploadId}</UploadId><Initiator><ID>${result.initiator.id}</ID><DisplayName>${result.initiator.displayName}</DisplayName></Initiator><Owner><ID>${result.owner.id}</ID><DisplayName>${result.owner.displayName}</DisplayName></Owner><StorageClass>${result.storageClass}</StorageClass><PartNumberMarker>${result.partNumberMarker}</PartNumberMarker><NextPartNumberMarker>${result.nextPartNumberMarker}</NextPartNumberMarker><MaxParts>${result.maxParts}</MaxParts><IsTruncated>${result.isTruncated}</IsTruncated>${partsXml}</ListPartsResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
        },
      });
    },

    formatObjectAttributes: (result) => {
      const etagXml = result.etag ? `<ETag>${result.etag}</ETag>` : "";
      const storageClassXml = result.storageClass
        ? `<StorageClass>${result.storageClass}</StorageClass>`
        : "";
      const objectSizeXml = result.objectSize !== undefined
        ? `<ObjectSize>${result.objectSize}</ObjectSize>`
        : "";
      const checksumAlgorithmXml = result.checksumAlgorithm
        ? `<ChecksumAlgorithm>${result.checksumAlgorithm}</ChecksumAlgorithm>`
        : "";

      let checksumXml = "";
      if (result.checksum) {
        const {
          checksumCRC32,
          checksumCRC32C,
          checksumCRC64NVME,
          checksumSHA1,
          checksumSHA256,
        } = result.checksum;
        checksumXml = `<Checksum>${
          checksumCRC32 ? `<ChecksumCRC32>${checksumCRC32}</ChecksumCRC32>` : ""
        }${
          checksumCRC32C
            ? `<ChecksumCRC32C>${checksumCRC32C}</ChecksumCRC32C>`
            : ""
        }${
          checksumCRC64NVME
            ? `<ChecksumCRC64NVME>${checksumCRC64NVME}</ChecksumCRC64NVME>`
            : ""
        }${checksumSHA1 ? `<ChecksumSHA1>${checksumSHA1}</ChecksumSHA1>` : ""}${
          checksumSHA256
            ? `<ChecksumSHA256>${checksumSHA256}</ChecksumSHA256>`
            : ""
        }</Checksum>`;
      }

      let objectPartsXml = "";
      if (result.objectParts) {
        const partsXml = (result.objectParts.parts ?? []).map((p) => {
          const checksumCRC32Xml = p.checksumCRC32
            ? `<ChecksumCRC32>${p.checksumCRC32}</ChecksumCRC32>`
            : "";
          const checksumCRC32CXml = p.checksumCRC32C
            ? `<ChecksumCRC32C>${p.checksumCRC32C}</ChecksumCRC32C>`
            : "";
          const checksumCRC64NVMEXml = p.checksumCRC64NVME
            ? `<ChecksumCRC64NVME>${p.checksumCRC64NVME}</ChecksumCRC64NVME>`
            : "";
          const checksumSHA1Xml = p.checksumSHA1
            ? `<ChecksumSHA1>${p.checksumSHA1}</ChecksumSHA1>`
            : "";
          const checksumSHA256Xml = p.checksumSHA256
            ? `<ChecksumSHA256>${p.checksumSHA256}</ChecksumSHA256>`
            : "";

          return `<Part><PartNumber>${p.partNumber}</PartNumber><Size>${p.size}</Size><ETag>${p.etag}</ETag>${checksumCRC32Xml}${checksumCRC32CXml}${checksumCRC64NVMEXml}${checksumSHA1Xml}${checksumSHA256Xml}</Part>`;
        }).join("");

        objectPartsXml = `<ObjectParts><PartsCount>${
          result.objectParts.partsCount ?? 0
        }</PartsCount>${partsXml}</ObjectParts>`;
      }

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><GetObjectAttributesResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${checksumXml}${checksumAlgorithmXml}${etagXml}${objectPartsXml}${objectSizeXml}${storageClassXml}</GetObjectAttributesResult>`;

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml",
        },
      });
    },
  }),
);
