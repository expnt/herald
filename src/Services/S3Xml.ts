import { Context, Layer } from "effect";
import { HttpServerResponse } from "@effect/platform";
import {
  AccessDenied,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  type BucketInfo,
  BucketNotEmpty,
  InternalError,
  type ListObjectsResult,
  NoSuchBucket,
  NoSuchKey,
  type OwnerInfo,
} from "./Backend.ts";

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
        result.encodingType === "url"
          ? encodeURIComponent(s).replace(/%2F/g, "/")
          : s;

      const contentsXml = result.contents.map((c) => `
        <Contents>
          <Key>${encode(c.key)}</Key>
          <LastModified>${c.lastModified.toISOString()}</LastModified>
          <ETag>${c.etag}</ETag>
          <Size>${c.size}</Size>
          <StorageClass>${c.storageClass ?? "STANDARD"}</StorageClass>
          ${
        c.owner
          ? `<Owner><ID>${c.owner.id}</ID><DisplayName>${c.owner.displayName}</DisplayName></Owner>`
          : ""
      }
        </Contents>
      `).join("");

      const commonPrefixesXml = result.commonPrefixes.map((cp) => `
        <CommonPrefixes>
          <Prefix>${encode(cp.prefix)}</Prefix>
        </CommonPrefixes>
      `).join("");

      let xml: string;
      if (result.listType === 2) {
        // ListObjectsV2
        xml = `<?xml version="1.0" encoding="UTF-8"?>
          <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <Name>${result.name}</Name>
            <Prefix>${encode(result.prefix ?? "")}</Prefix>
            <KeyCount>${
          result.keyCount ??
            (result.contents.length + result.commonPrefixes.length)
        }</KeyCount>
            <MaxKeys>${result.maxKeys}</MaxKeys>
            <Delimiter>${encode(result.delimiter ?? "")}</Delimiter>
            <IsTruncated>${result.isTruncated}</IsTruncated>
            ${
          result.continuationToken
            ? `<ContinuationToken>${result.continuationToken}</ContinuationToken>`
            : ""
        }
            ${
          result.nextContinuationToken
            ? `<NextContinuationToken>${result.nextContinuationToken}</NextContinuationToken>`
            : ""
        }
            ${
          result.startAfter
            ? `<StartAfter>${encode(result.startAfter)}</StartAfter>`
            : ""
        }
            ${
          result.encodingType
            ? `<EncodingType>${result.encodingType}</EncodingType>`
            : ""
        }
            ${contentsXml}
            ${commonPrefixesXml}
          </ListBucketResult>
        `;
      } else {
        // ListObjectsV1
        xml = `<?xml version="1.0" encoding="UTF-8"?>
          <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <Name>${result.name}</Name>
            <Prefix>${encode(result.prefix ?? "")}</Prefix>
            <Marker>${encode(result.marker ?? "")}</Marker>
            ${
          result.nextMarker
            ? `<NextMarker>${encode(result.nextMarker)}</NextMarker>`
            : ""
        }
            <MaxKeys>${result.maxKeys}</MaxKeys>
            <Delimiter>${encode(result.delimiter ?? "")}</Delimiter>
            <IsTruncated>${result.isTruncated}</IsTruncated>
            ${
          result.encodingType
            ? `<EncodingType>${result.encodingType}</EncodingType>`
            : ""
        }
            ${contentsXml}
            ${commonPrefixesXml}
          </ListBucketResult>
        `;
      }

      // Clean up whitespace between tags
      const cleanXml = xml.replace(/>\s+</g, "><").trim();

      return HttpServerResponse.text(cleanXml, {
        headers: {
          "Content-Type": "application/xml",
        },
      });
    },

    formatListVersions: (result) => {
      const encode = (s: string) =>
        result.encodingType === "url"
          ? encodeURIComponent(s).replace(/%2F/g, "/")
          : s;

      const versionsXml = result.contents.filter((c) => !c.isDeleteMarker).map(
        (v) => `
        <Version>
          <Key>${encode(v.key)}</Key>
          <VersionId>${v.versionId ?? "null"}</VersionId>
          <IsLatest>${v.isLatest ?? true}</IsLatest>
          <LastModified>${v.lastModified.toISOString()}</LastModified>
          <ETag>${v.etag}</ETag>
          <Size>${v.size}</Size>
          <StorageClass>${v.storageClass ?? "STANDARD"}</StorageClass>
          ${
          v.owner
            ? `<Owner><ID>${v.owner.id}</ID><DisplayName>${v.owner.displayName}</DisplayName></Owner>`
            : ""
        }
        </Version>
      `,
      ).join("");

      const deleteMarkersXml = result.contents.filter((c) => c.isDeleteMarker)
        .map((dm) => `
        <DeleteMarker>
          <Key>${encode(dm.key)}</Key>
          <VersionId>${dm.versionId ?? "null"}</VersionId>
          <IsLatest>${dm.isLatest ?? true}</IsLatest>
          <LastModified>${dm.lastModified.toISOString()}</LastModified>
          ${
          dm.owner
            ? `<Owner><ID>${dm.owner.id}</ID><DisplayName>${dm.owner.displayName}</DisplayName></Owner>`
            : ""
        }
        </DeleteMarker>
      `).join("");

      const commonPrefixesXml = result.commonPrefixes.map((cp) => `
        <CommonPrefixes>
          <Prefix>${encode(cp.prefix)}</Prefix>
        </CommonPrefixes>
      `).join("");

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
          <Name>${result.name}</Name>
          <Prefix>${encode(result.prefix ?? "")}</Prefix>
          <KeyMarker>${encode(result.marker ?? "")}</KeyMarker>
          <VersionIdMarker></VersionIdMarker>
          <MaxKeys>${result.maxKeys}</MaxKeys>
          <Delimiter>${encode(result.delimiter ?? "")}</Delimiter>
          <IsTruncated>${result.isTruncated}</IsTruncated>
          ${versionsXml}
          ${deleteMarkersXml}
          ${commonPrefixesXml}
        </ListVersionsResult>
      `;

      const cleanXml = xml.replace(/>\s+</g, "><").trim();

      return HttpServerResponse.text(cleanXml, {
        headers: {
          "Content-Type": "application/xml",
        },
      });
    },
  }),
);
