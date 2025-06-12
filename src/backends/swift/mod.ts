import {
  abortMultipartUpload,
  completeMultipartUpload,
  copyObject,
  createMultipartUpload,
  deleteObject,
  getObject,
  getObjectMeta,
  headObject,
  listMultipartUploads,
  listObjects,
  listParts,
  putObject,
  uploadPart,
  uploadPartCopy,
} from "./objects.ts";
import {
  createBucket,
  deleteBucket,
  getBucketAccelerate,
  getBucketAcl,
  getBucketCors,
  getBucketEncryption,
  getBucketLifecycle,
  getBucketLogging,
  getBucketObjectLock,
  getBucketPayment,
  getBucketPolicy,
  getBucketReplication,
  getBucketTagging,
  getBucketVersioning,
  getBucketWebsite,
  headBucket,
} from "./buckets.ts";
import { HeraldError } from "../../types/http-exception.ts";
import { getLogger } from "../../utils/log.ts";
import { s3Utils } from "../../utils/mod.ts";
import { Bucket } from "../../buckets/mod.ts";
import { HeraldContext } from "../../types/mod.ts";
import { formatRFC3339Date } from "./utils/mod.ts";
import { InternalServerErrorException } from "../../constants/errors.ts";

const handlers = {
  putObject,
  getObject,
  deleteObject,
  getObjectMeta,
  createBucket,
  deleteBucket,
  listObjects,
  headBucket,
  headObject,
  copyObject,
  createMultipartUpload,
  completeMultipartUpload,
  uploadPart,
  listParts,
  listMultipartUploads,
  uploadPartCopy,
  abortMultipartUpload,
};

const logger = getLogger(import.meta);
export async function swiftResolver(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  // FIXME: `resolveHandler` has already extracted request info
  // it is also called in other functions invoked hereafter
  // multiple times if replicas are involved
  const { method, objectKey } = s3Utils.extractRequestInfo(req);
  const url = new URL(req.url);
  const queryParam = url.searchParams.keys().next().value;

  logger.debug(`Resolving Swift Handler for Request...`);
  // Handle query parameter-based requests
  if (queryParam) {
    switch (queryParam) {
      case "policy":
        return await getBucketPolicy(ctx, req, bucketConfig);
      case "acl":
        return await getBucketAcl(ctx, req, bucketConfig);
      case "versioning":
        return await getBucketVersioning(ctx, req, bucketConfig);
      case "accelerate":
        return getBucketAccelerate(ctx, req, bucketConfig);
      case "logging":
        return getBucketLogging(ctx, req, bucketConfig);
      case "lifecycle":
        return getBucketLifecycle(ctx, req, bucketConfig);
      case "website":
        return getBucketWebsite(ctx, req, bucketConfig);
      case "requestPayment":
        return getBucketPayment(ctx, req, bucketConfig);
      case "encryption":
        return await getBucketEncryption(ctx, req, bucketConfig);
      case "cors":
        return getBucketCors(ctx, req, bucketConfig);
      case "replication":
        return getBucketReplication(ctx, req, bucketConfig);
      case "object-lock":
        return getBucketObjectLock(ctx, req, bucketConfig);
      case "tagging":
        return await getBucketTagging(ctx, req, bucketConfig);
      // ignore these as they will be handled as regular request below
      case "x-id":
      case "list-type":
        break;
      default:
        break;
    }
  }

  const queryParamKeys = new Set(url.searchParams.keys());
  // Handle regular requests
  switch (method) {
    case "GET":
      if (objectKey && queryParamKeys.has("uploadId")) {
        return await handlers.listParts(ctx, req, bucketConfig);
      }

      if (objectKey) {
        return await handlers.getObject(ctx, req, bucketConfig);
      }

      if (queryParamKeys.has("uploads")) {
        return await handlers.listMultipartUploads(ctx, req, bucketConfig);
      }

      return await handlers.listObjects(ctx, req, bucketConfig);
    case "POST":
      if (objectKey && queryParamKeys.has("uploads")) {
        return await handlers.createMultipartUpload(ctx, req, bucketConfig);
      }

      if (objectKey && queryParamKeys.has("uploadId")) {
        return await handlers.completeMultipartUpload(
          ctx,
          req,
          bucketConfig,
        );
      }
      break;
    case "PUT":
      if (
        objectKey && queryParamKeys.has("partNumber") &&
        queryParamKeys.has("uploadId") &&
        req.headers.get("x-amz-copy-source")
      ) {
        return await handlers.uploadPartCopy(ctx, req, bucketConfig);
      }

      if (objectKey && req.headers.get("x-amz-copy-source")) {
        return await handlers.copyObject(ctx, req, bucketConfig);
      }

      if (objectKey && queryParamKeys.has("partNumber")) {
        return await handlers.uploadPart(ctx, req, bucketConfig);
      }

      if (objectKey) {
        return await handlers.putObject(ctx, req, bucketConfig);
      }

      return await handlers.createBucket(ctx, req, bucketConfig);
    case "DELETE":
      if (objectKey && queryParamKeys.has("uploadId")) {
        return await handlers.abortMultipartUpload(ctx, req, bucketConfig);
      }
      if (objectKey) {
        return await handlers.deleteObject(ctx, req, bucketConfig);
      }

      return await handlers.deleteBucket(ctx, req, bucketConfig);
    case "HEAD":
      if (objectKey) {
        return await handlers.headObject(ctx, req, bucketConfig);
      }

      return await handlers.headBucket(ctx, req, bucketConfig);
    default:
      logger.critical(`Unsupported Request: ${method}`);
      return new HeraldError(400, { message: "Unsupported Request" });
  }

  return new HeraldError(405, { message: "Method Not Allowed" });
}

export function convertSwiftGetObjectToS3Response(
  swiftResponse: Response,
  queryParams: Record<string, string[]>,
) {
  const swiftStatus = swiftResponse.status;
  const swiftHeaders = swiftResponse.headers;

  if (swiftStatus === 200) {
    // Successful GetObject
    const eTag = swiftHeaders.get("etag");
    const lastModified = swiftHeaders.get("last-modified");
    const contentLength = swiftHeaders.get("content-length");
    const acceptRanges = swiftHeaders.get("accept-ranges");
    const contentType = swiftHeaders.get("content-type") ||
      "application/octet-stream";

    if (!eTag || !lastModified || !contentLength) {
      return new HeraldError(502, {
        message: "Missing essential headers in Swift response",
      });
    }

    const s3ContentType = queryParams["response-content-type"]
      ? queryParams["response-content-type"][0]
      : contentType;

    const s3ResponseHeaders = new Headers();

    s3ResponseHeaders.set("ETag", eTag);
    s3ResponseHeaders.set(
      "Last-Modified",
      new Date(lastModified).toUTCString(),
    );
    s3ResponseHeaders.set("Content-Length", contentLength);
    s3ResponseHeaders.set("Content-Type", s3ContentType);

    if (acceptRanges) {
      s3ResponseHeaders.set("accept-ranges", acceptRanges);
    }

    const requestId = swiftHeaders.get("x-openstack-request-id") ||
      swiftHeaders.get("x-trans-id");
    if (requestId) {
      s3ResponseHeaders.set("x-amz-request-id", requestId);
    }

    // Map metadata headers
    swiftHeaders.forEach((value, key) => {
      if (key.startsWith("x-object-meta-")) {
        const metaKey = key.substring("x-object-meta-".length);
        s3ResponseHeaders.set(`x-amz-meta-${metaKey}`, value);
      }
    });

    // https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html#API_GetObject_ResponseSyntax
    return new Response(swiftResponse.body, {
      status: 200,
      headers: s3ResponseHeaders,
    });
  }

  // Now handle mapped error cases
  let errorCode = "";
  let errorMessage = "";
  let errorStatus = 0;

  switch (swiftStatus) {
    case 404:
      errorCode = "NoSuchKey";
      errorMessage = "The specified key does not exist.";
      errorStatus = 404;
      break;
    case 416:
      errorCode = "InvalidObjectState";
      errorMessage = "The object is archived and inaccessible until restored.";
      errorStatus = 403;
      break;
    default:
      // Unhandled Swift error
      return new HeraldError(swiftStatus, {
        message: `Unhandled Swift error: ${swiftResponse.statusText}`,
      });
  }

  // Build proper S3 error XML
  const s3ErrorXml = `
<Error>
  <Code>${errorCode}</Code>
  <Message>${errorMessage}</Message>
  <RequestId>${
    swiftHeaders.get("x-openstack-request-id") ||
    swiftHeaders.get("x-trans-id") || "Unknown"
  }</RequestId>
  <HostId>swift-mapped-to-s3</HostId>
</Error>`.trim();

  return new Response(s3ErrorXml, {
    status: errorStatus,
    headers: new Headers({
      "Content-Type": "application/xml",
    }),
  });
}

export function convertSwiftUploadPartToS3Response(swiftResponse: Response) {
  if (!swiftResponse.ok) {
    return new HeraldError(swiftResponse.status, {
      message: `Upload Part Failed: ${swiftResponse.statusText}`,
    });
  }

  const swiftHeaders = swiftResponse.headers;
  const eTag = swiftHeaders.get("etag");

  if (!eTag) {
    logger.error("Etag not found in Upload Part response");
    return InternalServerErrorException();
  }

  const s3ResponseHeaders = new Headers();
  s3ResponseHeaders.set("ETag", eTag);

  const s3Response = new Response(null, {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPart.html#API_UploadPart_ResponseSyntax
    status: 200,
    headers: s3ResponseHeaders,
  });

  return s3Response;
}

export function convertSwiftPutObjectToS3Response(swiftResponse: Response) {
  const swiftStatus = swiftResponse.status;
  const swiftHeaders = swiftResponse.headers;

  if (swiftStatus === 201) {
    // Success: Map to 200 OK with necessary headers
    const eTag = swiftHeaders.get("etag");
    const contentLength = swiftHeaders.get("content-length");
    const requestId = swiftHeaders.get("x-openstack-request-id") ||
      swiftHeaders.get("x-trans-id");

    if (!eTag) {
      return new HeraldError(502, {
        message: "Missing ETag in Swift response",
      });
    }

    const s3ResponseHeaders = new Headers();
    s3ResponseHeaders.set("ETag", eTag);

    if (contentLength) {
      s3ResponseHeaders.set("content-length", contentLength);
    }

    if (requestId) {
      s3ResponseHeaders.set("x-amz-request-id", requestId);
    }

    return new Response(null, {
      status: 200, // S3 returns 200 OK
      headers: s3ResponseHeaders,
    });
  }

  // Error handling based on Swift response codes
  let errorCode = "InvalidRequest";
  let errorMessage = "Bad Request";

  switch (swiftStatus) {
    case 404:
      errorCode = "InvalidRequest";
      errorMessage = "The specified container does not exist.";
      break;
    case 408:
      errorCode = "RequestTimeout";
      errorMessage = "The request timed out.";
      break;
    case 411:
      errorCode = "InvalidRequest";
      errorMessage = "Missing Content-Length or Transfer-Encoding.";
      break;
    case 422:
      errorCode = "InvalidRequest"; // or custom "ChecksumMismatch" if you prefer
      errorMessage = "Checksum mismatch.";
      break;
    default:
      // Unknown/unexpected error
      return new HeraldError(swiftStatus, {
        message: `Unhandled error from Swift: ${swiftResponse.statusText}`,
      });
  }

  const s3ErrorXml = `
<Error>
  <Code>${errorCode}</Code>
  <Message>${errorMessage}</Message>
  <RequestId>${
    swiftHeaders.get("x-openstack-request-id") ||
    swiftHeaders.get("x-trans-id") || "Unknown"
  }</RequestId>
  <HostId>swift-mapped-to-s3</HostId>
</Error>`.trim();

  return new Response(s3ErrorXml, {
    status: 400, // All mapped errors use 400 except 408 timeout
    headers: new Headers({
      "Content-Type": "application/xml",
    }),
  });
}

export function convertSwiftCopyObjectToS3Response(
  swiftResponse: Response,
) {
  const swiftStatus = swiftResponse.status;
  const swiftHeaders = swiftResponse.headers;

  if (swiftStatus === 201) {
    // Successful CopyObject operation

    const eTag = swiftHeaders.get("etag");
    const lastModified = swiftHeaders.get("last-modified");
    const requestId = swiftHeaders.get("x-openstack-request-id") ||
      swiftHeaders.get("x-trans-id");

    if (!eTag || !lastModified) {
      return new HeraldError(502, {
        message: "Missing essential headers in Swift response for CopyObject",
      });
    }

    const s3ResponseHeaders = new Headers();

    // Set standard S3 CopyObject headers
    if (requestId) {
      s3ResponseHeaders.set("x-amz-copy-source-version-id", requestId);
      s3ResponseHeaders.set("x-amz-version-id", requestId);
      s3ResponseHeaders.set("x-amz-request-id", requestId);
    }

    s3ResponseHeaders.set("ETag", eTag);

    const s3ResponseBody = `
<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult>
  <ETag>${`"${eTag.replace(/^"|"$/g, "")}"`}</ETag>
  <LastModified>${formatRFC3339Date(lastModified)}</LastModified>
</CopyObjectResult>`.trim();

    return new Response(s3ResponseBody, {
      status: 200, // S3 CopyObject always returns 200 OK, not 201
      headers: s3ResponseHeaders,
    });
  }

  // Handle error mapping if CopyObject failed
  let errorCode = "";
  let errorMessage = "";
  let errorStatus = 0;

  switch (swiftStatus) {
    case 404:
      errorCode = "NoSuchKey";
      errorMessage = "The source object does not exist.";
      errorStatus = 404;
      break;
    case 416:
      errorCode = "InvalidObjectState";
      errorMessage =
        "The source object is archived and must be restored before copying.";
      errorStatus = 403;
      break;
    default:
      return new HeraldError(swiftStatus, {
        message:
          `Unhandled Swift CopyObject error: ${swiftResponse.statusText}`,
      });
  }

  const s3ErrorXml = `
<Error>
  <Code>${errorCode}</Code>
  <Message>${errorMessage}</Message>
  <RequestId>${
    swiftHeaders.get("x-openstack-request-id") ||
    swiftHeaders.get("x-trans-id") || "Unknown"
  }</RequestId>
  <HostId>swift-mapped-to-s3</HostId>
</Error>`.trim();

  return new Response(s3ErrorXml, {
    status: errorStatus,
    headers: new Headers({
      "Content-Type": "application/xml",
    }),
  });
}

export function convertSwiftDeleteObjectToS3Response(swiftResponse: Response) {
  if (!swiftResponse.ok) {
    return new HeraldError(swiftResponse.status, {
      message: `Delete Object Failed: ${swiftResponse.statusText}`,
    });
  }

  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html#API_DeleteObject_ResponseSyntax
  const s3Response = new Response(null, {
    status: 204,
  });

  return s3Response;
}

function createBucketSuccessResponse(bucketName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>${bucketName}</Location>
</CreateBucketConfiguration>`;
}

export function convertSwiftCreateBucketToS3Response(
  swiftResponse: Response,
  bucketName: string, // We need the intended bucket name for the Location header
) {
  const swiftStatus = swiftResponse.status;
  const swiftHeaders = swiftResponse.headers;

  if (swiftStatus === 201 || swiftStatus === 202) {
    // Successful CreateBucket
    const requestId = swiftHeaders.get("x-openstack-request-id") ||
      swiftHeaders.get("x-trans-id");

    const s3ResponseHeaders = new Headers();

    if (requestId) {
      s3ResponseHeaders.set("x-amz-request-id", requestId);
    }
    s3ResponseHeaders.set("Location", `/${bucketName}`);

    return new Response(createBucketSuccessResponse(bucketName), {
      status: 200,
      headers: s3ResponseHeaders,
    });
  }

  // Now handle mapped error cases
  let errorCode = "";
  let errorMessage = "";
  const errorStatus = 409;

  switch (swiftStatus) {
    case 400:
    case 507:
      errorCode = "BucketAlreadyExists";
      errorMessage =
        "The requested bucket name is not available. Select a different name and try again.";
      break;
    case 404:
      errorCode = "BucketAlreadyOwnedByYou";
      errorMessage =
        "The bucket you tried to create already exists, and you own it.";
      break;
    default:
      return new HeraldError(swiftStatus, {
        message:
          `Unhandled Swift CreateBucket error: ${swiftResponse.statusText}`,
      });
  }

  const s3ErrorXml = `
<Error>
  <Code>${errorCode}</Code>
  <Message>${errorMessage}</Message>
  <RequestId>${
    swiftHeaders.get("x-openstack-request-id") ||
    swiftHeaders.get("x-trans-id") || "Unknown"
  }</RequestId>
  <HostId>swift-mapped-to-s3</HostId>
</Error>`.trim();

  return new Response(s3ErrorXml, {
    status: errorStatus,
    headers: new Headers({
      "Content-Type": "application/xml",
    }),
  });
}

export function convertSwiftHeadBucketToS3Response(
  swiftResponse: Response,
  bucketRegion = "us-east-1", // Default region
) {
  const swiftStatus = swiftResponse.status;
  const swiftHeaders = swiftResponse.headers;

  if (swiftStatus === 204) {
    // Successful HeadBucket

    const requestId = swiftHeaders.get("x-openstack-request-id") ||
      swiftHeaders.get("x-trans-id");

    const s3ResponseHeaders = new Headers();

    if (requestId) {
      s3ResponseHeaders.set("x-amz-request-id", requestId);
    }

    // S3 HeadBucket returns info about bucket location
    s3ResponseHeaders.set("x-amz-bucket-region", bucketRegion);
    s3ResponseHeaders.set("x-amz-bucket-location-type", "AvailabilityZone");
    s3ResponseHeaders.set("x-amz-bucket-location-name", bucketRegion);

    // Optional: you can map Accept-Ranges if Swift sends it
    const acceptRanges = swiftHeaders.get("accept-ranges");
    if (acceptRanges) {
      s3ResponseHeaders.set("accept-ranges", acceptRanges);
    }

    return new Response(null, {
      status: 200,
      headers: s3ResponseHeaders,
    });
  }

  // Handle error mapping
  if (swiftStatus === 404) {
    const s3ErrorXml = `
<Error>
  <Code>NoSuchBucket</Code>
  <Message>The specified bucket does not exist.</Message>
  <RequestId>${
      swiftHeaders.get("x-openstack-request-id") ||
      swiftHeaders.get("x-trans-id") || "Unknown"
    }</RequestId>
  <HostId>swift-mapped-to-s3</HostId>
</Error>`.trim();

    return new Response(s3ErrorXml, {
      status: 404,
      headers: new Headers({
        "Content-Type": "application/xml",
      }),
    });
  }

  // Unhandled errors fallback
  return new HeraldError(swiftStatus, {
    message: `Unhandled Swift HeadBucket error: ${swiftResponse.statusText}`,
  });
}

export function convertSwiftHeadObjectToS3Response(
  swiftResponse: Response,
) {
  const swiftStatus = swiftResponse.status;
  const swiftHeaders = swiftResponse.headers;

  if (swiftStatus === 200) {
    // Successful HeadObject

    const eTag = swiftHeaders.get("etag");
    const contentLength = swiftHeaders.get("content-length");
    const lastModified = swiftHeaders.get("last-modified");
    const acceptRanges = swiftHeaders.get("accept-ranges");
    const contentType = swiftHeaders.get("content-type") ||
      "application/octet-stream";
    const requestId = swiftHeaders.get("x-openstack-request-id") ||
      swiftHeaders.get("x-trans-id");

    if (!eTag || !contentLength || !lastModified) {
      return new HeraldError(502, {
        message: "Missing essential headers in Swift response for HeadObject",
      });
    }

    const s3ResponseHeaders = new Headers();

    // Set standard fields
    s3ResponseHeaders.set("ETag", `"${eTag.replace(/^"|"$/g, "")}"`); // Ensure ETag is quoted
    s3ResponseHeaders.set("Content-Length", contentLength);
    s3ResponseHeaders.set(
      "Last-Modified",
      new Date(lastModified).toUTCString(),
    );
    s3ResponseHeaders.set("Content-Type", contentType);

    if (acceptRanges) {
      s3ResponseHeaders.set("accept-ranges", acceptRanges);
    }
    if (requestId) {
      s3ResponseHeaders.set("x-amz-request-id", requestId);
    }

    // Map Swift user metadata
    swiftHeaders.forEach((value, key) => {
      if (key.startsWith("x-object-meta-")) {
        const metaKey = key.substring("x-object-meta-".length);
        s3ResponseHeaders.set(`x-amz-meta-${metaKey}`, value);
      }
    });

    return new Response(null, {
      status: 200,
      headers: s3ResponseHeaders,
    });
  }

  // Now handle error mapping
  if (swiftStatus === 404) {
    const s3ErrorXml = `
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <RequestId>${
      swiftHeaders.get("x-openstack-request-id") ||
      swiftHeaders.get("x-trans-id") || "Unknown"
    }</RequestId>
  <HostId>swift-mapped-to-s3</HostId>
</Error>`.trim();

    return new Response(s3ErrorXml, {
      status: 404,
      headers: new Headers({
        "Content-Type": "application/xml",
      }),
    });
  }

  // Fallback for unhandled Swift errors
  return new HeraldError(swiftStatus, {
    message: `Unhandled Swift HeadObject error: ${swiftResponse.statusText}`,
  });
}
