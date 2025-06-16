import {
  abortMultipartUpload,
  completeMultipartUpload,
  copyObject,
  createMultipartUpload,
  deleteObject,
  getObject,
  headObject,
  listObjects,
  putObject,
} from "./objects.ts";
import {
  createBucket,
  deleteBucket,
  headBucket,
  routeQueryParamedRequest,
} from "./buckets.ts";
import { HeraldError } from "../../types/http-exception.ts";
import { areQueryParamsSupported } from "../../utils/url.ts";
import { extractRequestInfo } from "../../utils/s3.ts";
import { Bucket } from "../../buckets/mod.ts";
import { RequestContext } from "../../types/mod.ts";
import { APIErrors, getAPIErrorResponse } from "../../types/api_errors.ts";
import { createErr, createOk, Result } from "option-t/plain_result";

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
};

export async function s3Resolver(
  reqCtx: RequestContext,
  request: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;

  // FIXME: `resolveHandler` has already extracted request info
  const { method, objectKey, queryParams } = extractRequestInfo(request);
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

      if (!areQueryParamsSupported(queryParamKeys)) {
        logger.critical("Unsupported Query Parameter Used");
        return createErr(
          new HeraldError(400, {
            message: "Unsupported Query Parameter Used",
          }),
        );
      }
      return await handlers.routeQueryParamedRequest(
        reqCtx,
        request,
        bucketConfig,
        queryParamKeys,
      );
    case "POST":
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

      return createErr(
        new HeraldError(403, {
          message: "Unsupported request",
        }),
      );
    case "PUT":
      if (objectKey && request.headers.get("x-amz-copy-source")) {
        return await handlers.copyObject(reqCtx, request, bucketConfig);
      }

      if (objectKey) {
        return await handlers.putObject(reqCtx, request, bucketConfig);
      }

      return await handlers.createBucket(reqCtx, request, bucketConfig);
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

      return await handlers.deleteBucket(reqCtx, request, bucketConfig);
    case "HEAD":
      if (objectKey) {
        return await handlers.headObject(reqCtx, request, bucketConfig);
      }
      return await handlers.headBucket(reqCtx, request, bucketConfig);
    default:
      logger.critical(`Unsupported Request Method: ${method}`);
      return createOk(getAPIErrorResponse(APIErrors.ErrInvalidRequest));
  }
}
