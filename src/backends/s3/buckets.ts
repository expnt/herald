import {
  formatParams,
  forwardS3RequestToS3WithTimeouts,
} from "../../utils/url.ts";
import { reportToSentry } from "../../utils/log.ts";
import { S3Config } from "../../config/mod.ts";
import { prepareMirrorRequests } from "../mirror.ts";
import { Bucket } from "../../buckets/mod.ts";
import { s3Resolver } from "./mod.ts";
import { swiftResolver } from "../swift/mod.ts";
import { RequestContext } from "../../types/mod.ts";
import { isOk, Result, unwrapErr, unwrapOk } from "option-t/plain_result";

export async function listBuckets(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying List Buckets Request...");

  const config: S3Config = bucketConfig.config as S3Config;

  const response = await forwardS3RequestToS3WithTimeouts(
    req,
    config,
  );

  if (!isOk(response)) {
    const err = unwrapErr(response);
    logger.warn(
      `List Buckets Failed. Failed to connect with Object Storage: ${err.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);

  if (successResponse.status !== 200) {
    const errMessage = `List Buckets Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`List Buckets Successful: ${successResponse.statusText}`);
  }

  return response;
}

export async function createBucket(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying Create Bucket Request...");

  const config: S3Config = bucketConfig.config as S3Config;
  const mirrorOperation = bucketConfig.hasReplicas();

  const response = await forwardS3RequestToS3WithTimeouts(
    req,
    config,
  );

  if (!isOk(response)) {
    const err = unwrapErr(response);
    logger.warn(
      `Create Bucket Failed. Failed to connect with Object Storage: ${err.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status != 200) {
    const errMessage = `Create Bucket Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Create Bucket Successful: ${successResponse.statusText}`);
    if (mirrorOperation) {
      await prepareMirrorRequests(
        reqCtx,
        req,
        bucketConfig,
        "createBucket",
      );
    }
  }

  return response;
}

export async function deleteBucket(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying Delete Bucket Request...");

  const config: S3Config = bucketConfig.config as S3Config;
  const mirrorOperation = bucketConfig.hasReplicas();

  const response = await forwardS3RequestToS3WithTimeouts(
    req,
    config,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Delete Bucket Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status != 204) {
    const errMessage = `Delete Bucket Failed: ${successResponse.statusText}`;
    reportToSentry(errMessage);
    logger.warn(errMessage);
  } else {
    logger.info(`Delete Bucket Successful: ${successResponse.statusText}`);
    if (mirrorOperation) {
      await prepareMirrorRequests(
        reqCtx,
        req,
        bucketConfig,
        "deleteBucket",
      );
    }
  }

  return response;
}

export async function routeQueryParamedRequest(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
  queryParams: Set<string>,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  const formattedParams = formatParams(queryParams);
  logger.info(`[S3 backend] Proxying Get Bucket ${formattedParams} Request...`);

  let response = await forwardS3RequestToS3WithTimeouts(
    req,
    bucketConfig.config as S3Config,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    logger.warn(
      `${formattedParams} Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(
          `${formattedParams} Operation Failed on Replica: ${replica.name}`,
        );
        continue;
      }
      response = res;
      break;
    }
  }

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `${formatParams} Operation Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status != 200) {
    const errMessage =
      `Get Bucket ${formattedParams} Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(
      `Get Bucket ${formattedParams} Successful: ${successResponse.statusText}`,
    );
  }

  return response;
}

export async function headBucket(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info(`[S3 backend] Proxying Head Bucket Request...`);

  let response = await forwardS3RequestToS3WithTimeouts(
    req,
    bucketConfig.config as S3Config,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (!isOk(response) && bucketConfig.hasReplicas()) {
    logger.warn(
      `Head Bucket Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(`Head Bucket Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
      break;
    }
  }

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Head Bucket Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 200 && successResponse.status !== 404) {
    const errMessage = `Head Bucket Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(
      `Head Bucket Successful: ${successResponse.statusText}`,
    );
  }

  return response;
}
