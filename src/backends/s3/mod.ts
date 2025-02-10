import {
  copyObject,
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
};

const logger = getLogger(import.meta);
export async function s3Resolver(
  request: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  const { method, objectKey, queryParams } = extractRequestInfo(request);
  const queryParamKeys = Object.keys(queryParams);

  logger.debug(`Resolving S3 Handler for Request...`);
  switch (method) {
    case "GET":
      if (objectKey) {
        return await handlers.getObject(request, bucketConfig);
      }
      if (queryParams["list-type"]) {
        return await handlers.listObjects(request, bucketConfig);
      }

      if (!areQueryParamsSupported(queryParamKeys)) {
        logger.critical("Unsupported Query Parameter Used");
        throw new HTTPException(400, {
          message: "Unsupported Query Parameter Used",
        });
      }
      return await handlers.routeQueryParamedRequest(
        request,
        bucketConfig,
        queryParamKeys,
      );
    case "POST":
      logger.critical("POST Method Not Supported");
      throw new HTTPException(405, {
        message: "Method Not Allowed",
      });
    case "PUT":
      if (objectKey && request.headers.get("x-amz-copy-source")) {
        return await handlers.copyObject(request, bucketConfig);
      }

      if (objectKey) {
        return await handlers.putObject(request, bucketConfig);
      }

      return await handlers.createBucket(request, bucketConfig);
    case "DELETE":
      if (objectKey) {
        return await handlers.deleteObject(request, bucketConfig);
      }

      return await handlers.deleteBucket(request, bucketConfig);
    case "HEAD":
      if (objectKey) {
        return await handlers.headObject(request, bucketConfig);
      }
      return await handlers.headBucket(request, bucketConfig);
    default:
      logger.critical(`Unsupported Request Method: ${method}`);
      throw new HTTPException(400, { message: "Unsupported Request" });
  }
}
