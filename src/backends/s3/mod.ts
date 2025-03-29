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
import { HTTPException } from "../../types/http-exception.ts";
import { areQueryParamsSupported } from "../../utils/url.ts";
import { extractRequestInfo } from "../../utils/s3.ts";
import { getLogger } from "../../utils/log.ts";
import { Bucket } from "../../buckets/mod.ts";
import { HeraldContext } from "../../types/mod.ts";

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

const logger = getLogger(import.meta);
export async function s3Resolver(
  ctx: HeraldContext,
  request: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  const { method, objectKey, queryParams } = extractRequestInfo(request);
  const queryParamKeys = new Set(Object.keys(queryParams));

  logger.debug(`Resolving S3 Handler for Request...`);
  switch (method) {
    case "GET":
      if (objectKey) {
        return await handlers.getObject(ctx, request, bucketConfig);
      }
      if (queryParams["list-type"]) {
        return await handlers.listObjects(ctx, request, bucketConfig);
      }

      if (!areQueryParamsSupported(queryParamKeys)) {
        logger.critical("Unsupported Query Parameter Used");
        throw new HTTPException(400, {
          message: "Unsupported Query Parameter Used",
        });
      }
      return await handlers.routeQueryParamedRequest(
        ctx,
        request,
        bucketConfig,
        queryParamKeys,
      );
    case "POST":
      if (objectKey && queryParamKeys.has("uploads")) {
        return handlers.createMultipartUpload(ctx, request, bucketConfig);
      }

      if (objectKey && queryParamKeys.has("uploadId")) {
        return await handlers.completeMultipartUpload(
          ctx,
          request,
          bucketConfig,
        );
      }

      return new HTTPException(403, {
        message: "Unsupported request",
      });
    case "PUT":
      if (objectKey && request.headers.get("x-amz-copy-source")) {
        return await handlers.copyObject(ctx, request, bucketConfig);
      }

      if (objectKey) {
        return await handlers.putObject(ctx, request, bucketConfig);
      }

      return await handlers.createBucket(ctx, request, bucketConfig);
    case "DELETE":
      if (objectKey && queryParamKeys.has("uploadId")) {
        return await handlers.abortMultipartUpload(ctx, request, bucketConfig);
      }
      if (objectKey) {
        return await handlers.deleteObject(ctx, request, bucketConfig);
      }

      return await handlers.deleteBucket(ctx, request, bucketConfig);
    case "HEAD":
      if (objectKey) {
        return await handlers.headObject(ctx, request, bucketConfig);
      }
      return await handlers.headBucket(ctx, request, bucketConfig);
    default:
      logger.critical(`Unsupported Request Method: ${method}`);
      throw new HTTPException(400, { message: "Unsupported Request" });
  }
}
