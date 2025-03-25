import {
  completeMultipartUpload,
  copyObject,
  createMultipartUpload,
  deleteObject,
  getObject,
  getObjectMeta,
  headObject,
  listObjects,
  putObject,
  uploadPart,
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
import { HTTPException } from "../../types/http-exception.ts";
import { getLogger } from "../../utils/log.ts";
import { s3Utils } from "../../utils/mod.ts";
import { Bucket } from "../../buckets/mod.ts";
import { HeraldContext } from "../../types/mod.ts";

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
};

const logger = getLogger(import.meta);
export async function swiftResolver(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
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
      if (objectKey) {
        return await handlers.getObject(ctx, req, bucketConfig);
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
      return new HTTPException(400, { message: "Unsupported Request" });
  }

  return new HTTPException(405, { message: "Method Not Allowed" });
}

export function convertSwiftGetToS3Response(
  swiftResponse: Response,
  queryParams: Record<string, string[]>,
) {
  // Check if the Swift response indicates success
  if (!swiftResponse.ok) {
    return new HTTPException(swiftResponse.status, {
      message: `Get Object Failed: ${swiftResponse.statusText}`,
    });
  }

  // Extract relevant headers from the Swift response
  const swiftHeaders = swiftResponse.headers;
  const eTag = swiftHeaders.get("etag");
  const lastModified = swiftHeaders.get("last-modified");
  const defaultContentType = swiftHeaders.get("content-type") ||
    "application/octet-stream";
  const contentLength = swiftHeaders.get("content-length");

  // Determine the content type based on the query parameter
  const s3ContentType = queryParams["response-content-type"]
    ? queryParams["response-content-type"][0]
    : defaultContentType;

  // Create a new set of headers for the S3 response
  const s3ResponseHeaders = new Headers();
  s3ResponseHeaders.set("ETag", eTag!);
  s3ResponseHeaders.set("Last-Modified", new Date(lastModified!).toUTCString());
  s3ResponseHeaders.set("Content-Type", s3ContentType);
  s3ResponseHeaders.set("Content-Length", contentLength!);

  // Copy other relevant headers, if any, that are expected in an S3 response
  swiftHeaders.forEach((value, key) => {
    if (key.startsWith("x-object-meta-")) {
      s3ResponseHeaders.set(`x-amz-meta-${key.substring(14)}`, value);
    }
  });

  // Return the new S3-like response
  return new Response(swiftResponse.body, {
    status: 200, // Success in S3 is indicated by HTTP 200
    headers: s3ResponseHeaders,
  });
}

export function convertSwiftDeleteToS3Response(swiftResponse: Response) {
  // Check the status of the Swift response
  if (!swiftResponse.ok) {
    // If the response is not successful, return a corresponding error
    return new HTTPException(swiftResponse.status, {
      message: `Delete Object Failed: ${swiftResponse.statusText}`,
    });
  }

  // Construct the S3-compliant response
  // S3 expects a 204 status code for a successful delete operation
  const s3Response = new Response(null, {
    status: 204, // No Content, which matches the success status of S3 and Swift DELETE response
  });

  return s3Response;
}

export function convertSwiftToS3Response(swiftResponse: Response) {
  // Check the status of the Swift response
  if (!swiftResponse.ok) {
    // If the response is not OK, return a corresponding error
    return new HTTPException(swiftResponse.status, {
      message: `Upload Part Failed: ${swiftResponse.statusText}`,
    });
  }

  // Extract relevant headers from the Swift response
  const swiftHeaders = swiftResponse.headers;
  const eTag = swiftHeaders.get("etag")!;

  // Construct the S3-compliant response
  // S3 expects a 200 status code with the ETag header for an upload part
  const s3ResponseHeaders = new Headers();
  s3ResponseHeaders.set("ETag", eTag);

  // Creating a new Response object for the S3 response
  const s3Response = new Response(null, {
    status: 200, // Uploaded parts typically respond with HTTP 200 in S3 when successful
    headers: s3ResponseHeaders,
  });

  return s3Response;
}
