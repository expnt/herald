import {
  abortMultipartUpload,
  completeMultipartUpload,
  copyObject,
  createMultipartUpload,
  deleteObject,
  deleteObjects,
  getObject,
  headObject,
  listObjects,
  putObject,
} from "./objects.ts";
import {
  createBucket,
  deleteBucket,
  headBucket,
  listBuckets,
  routeQueryParamedRequest,
} from "./buckets.ts";
import { areQueryParamsSupported } from "../../utils/url.ts";
import { extractRequestInfo } from "../../utils/s3.ts";
import { Bucket } from "../../buckets/mod.ts";
import { RequestContext } from "../../types/mod.ts";
import { createOk, Result } from "option-t/plain_result";

const handlers = {
  putObject,
  getObject,
  deleteObject,
  headObject,
  createBucket,
  deleteBucket,
  listObjects,
  routeQueryParamedRequest,
  headBucket,
  copyObject,
  createMultipartUpload,
  completeMultipartUpload,
  abortMultipartUpload,
  deleteObjects,
  listBuckets,
};

export async function s3Resolver(
  reqCtx: RequestContext,
  request: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;

  // FIXME: `resolveHandler` has already extracted request info
  const { bucket, method, objectKey, queryParams } = extractRequestInfo(
    request,
  );
  const url = new URL(request.url);
  const queryParamKeys = new Set(Object.keys(queryParams));

  logger.debug(`Resolving S3 Handler for Request...`);
  switch (method) {
    case "GET":
      if (objectKey) {
        return await handlers.getObject(reqCtx, request, bucketConfig);
      }
      if (queryParams["list-type"]) {
        return await handlers.listObjects(reqCtx, request, bucketConfig);
      }

      if (areQueryParamsSupported(queryParamKeys)) {
        return await handlers.routeQueryParamedRequest(
          reqCtx,
          request,
          bucketConfig,
          queryParamKeys,
        );
      }

      if (url.pathname === "/") {
        return await handlers.listBuckets(reqCtx, request, bucketConfig);
      }

      break;
    case "POST":
      if (queryParamKeys.has("delete")) {
        return await handlers.deleteObjects(
          reqCtx,
          request,
          bucketConfig,
        );
      }

      if (objectKey && queryParamKeys.has("uploads")) {
        return handlers.createMultipartUpload(reqCtx, request, bucketConfig);
      }

      if (objectKey && queryParamKeys.has("uploadId")) {
        return await handlers.completeMultipartUpload(
          reqCtx,
          request,
          bucketConfig,
        );
      }

      break;
    case "PUT":
      if (objectKey && request.headers.get("x-amz-copy-source")) {
        return await handlers.copyObject(reqCtx, request, bucketConfig);
      }

      if (objectKey) {
        return await handlers.putObject(reqCtx, request, bucketConfig);
      }

      if (bucket) {
        return await handlers.createBucket(reqCtx, request, bucketConfig);
      }

      break;
    case "DELETE":
      if (objectKey && queryParamKeys.has("uploadId")) {
        return await handlers.abortMultipartUpload(
          reqCtx,
          request,
          bucketConfig,
        );
      }
      if (objectKey) {
        return await handlers.deleteObject(reqCtx, request, bucketConfig);
      }

      if (bucket) {
        return await handlers.deleteBucket(reqCtx, request, bucketConfig);
      }

      break;
    case "HEAD":
      if (objectKey) {
        return await handlers.headObject(reqCtx, request, bucketConfig);
      }

      if (bucket) {
        return await handlers.headBucket(reqCtx, request, bucketConfig);
      }

      break;
    default:
      logger.warn(
        `Unsupported Request Method: ${method} on ${request.url}`,
      );
      return createOk(new Response("Proxy is running..."));
  }

  logger.warn(`Unsupported Request: method ${method} on ${request.url}`);
  return createOk(new Response("Proxy is running..."));
}
