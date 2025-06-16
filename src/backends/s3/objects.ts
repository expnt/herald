import { Context } from "@hono/hono";
import { forwardS3RequestToS3WithTimeouts } from "../../utils/url.ts";
import { reportToSentry } from "../../utils/log.ts";
import { S3Config } from "../../config/mod.ts";
import { prepareMirrorRequests } from "../mirror.ts";
import { Bucket } from "../../buckets/mod.ts";
import { swiftResolver } from "../swift/mod.ts";
import { s3Resolver } from "./mod.ts";
import { RequestContext } from "../../types/mod.ts";
import { extractRequestInfo } from "../../utils/s3.ts";
import { isOk, Result, unwrapErr, unwrapOk } from "option-t/plain_result";

export async function getObject(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying Get Object Request...");

  let response = await forwardS3RequestToS3WithTimeouts(
    req,
    bucketConfig.config as S3Config,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    logger.warn(
      `Get Object Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(`Get Object Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
      break;
    }
  }

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Get Object Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 200) {
    const errMessage = `Get Object Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Get Object Successful: ${successResponse.statusText}`);
  }

  return response;
}

export async function listObjects(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying List Objects Request...");

  let response = await forwardS3RequestToS3WithTimeouts(
    req,
    bucketConfig.config as S3Config,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    logger.warn(
      `List Objects Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(`List Objects Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
      break;
    }
  }

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `List Objects Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 200) {
    const errMessage = `List Objects Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`List Objects Successful: ${successResponse.statusText}`);
  }

  return response;
}

export async function putObject(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying Put Object Request...");

  const config: S3Config = bucketConfig.config as S3Config;
  const mirrorOperation = bucketConfig.hasReplicas();

  const response = await forwardS3RequestToS3WithTimeouts(
    req,
    config,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Put Object Failed. Failed to connect with Object Storage: ${errRes.message}`,
      { response },
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status != 200) {
    const errMessage = `Put Object Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Put Object Successful: ${successResponse.statusText}`);
    const { queryParams } = extractRequestInfo(req);
    if (mirrorOperation && !queryParams["uploadId"]) {
      await prepareMirrorRequests(
        reqCtx,
        req,
        bucketConfig,
        "putObject",
      );
    }
  }

  return response;
}

export async function deleteObject(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying Delete Object Request...");

  const config: S3Config = bucketConfig.config as S3Config;
  const mirrorOperation = bucketConfig.hasReplicas();

  const response = await forwardS3RequestToS3WithTimeouts(
    req,
    config,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Delete Object Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status != 204) {
    const errMesage = `Delete Object Failed: ${successResponse.statusText}`;
    logger.warn(`Delete Object Failed: ${successResponse.statusText}`);
    reportToSentry(errMesage);
  } else {
    logger.info(`Delete Object Successful: ${successResponse.statusText}`);
    if (mirrorOperation) {
      await prepareMirrorRequests(
        reqCtx,
        req,
        bucketConfig,
        "deleteObject",
      );
    }
  }

  return response;
}

export async function copyObject(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying Copy Object Request...");

  const config: S3Config = bucketConfig.config as S3Config;
  const mirrorOperation = bucketConfig.hasReplicas();

  const response = await forwardS3RequestToS3WithTimeouts(
    req,
    config,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Copy Object Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status != 200) {
    const errMessage = `Copy Object Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Copy Object Successful: ${successResponse.statusText}`);
    if (mirrorOperation) {
      await prepareMirrorRequests(
        reqCtx,
        req,
        bucketConfig,
        "copyObject",
      );
    }
  }

  return response;
}

export function getObjectMeta(c: Context) {
  return c.text("Not Implemented");
}

export async function headObject(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying Head Object Request...");

  let response = await forwardS3RequestToS3WithTimeouts(
    req,
    bucketConfig.config as S3Config,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (!isOk(response) && bucketConfig.hasReplicas()) {
    logger.warn(
      `Head Object Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(`Head Object Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
      break;
    }
  }

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Head Object Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status != 200 && successResponse.status !== 404) {
    const errMessage = `Head Object Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
  } else {
    logger.info(`Head Object Successful: ${successResponse.statusText}`);
  }

  return response;
}

export async function createMultipartUpload(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying Create Multipart Upload Request...");

  const response = await forwardS3RequestToS3WithTimeouts(
    req,
    bucketConfig.config as S3Config,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Create Multipart Upload Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 200) {
    const errMessage =
      `Create Multipart Upload Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(
      `Create Multipart Upload Successful: ${successResponse.statusText}`,
    );
  }

  return response;
}

export async function completeMultipartUpload(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying Complete Multipart Upload Request...");

  const mirrorOperation = bucketConfig.hasReplicas();
  const response = await forwardS3RequestToS3WithTimeouts(
    req,
    bucketConfig.config as S3Config,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Complete Multipart Upload Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 200) {
    const errMessage =
      `Complete Multipart Upload Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(
      `Complete Multipart Upload Successful: ${successResponse.statusText}`,
    );
    if (mirrorOperation) {
      await prepareMirrorRequests(
        reqCtx,
        req,
        bucketConfig,
        "completeMultipartUpload",
      );
    }
  }

  return response;
}

export async function listParts(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying List Parts Request...");

  let response = await forwardS3RequestToS3WithTimeouts(
    req,
    bucketConfig.config as S3Config,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (!isOk(response) && bucketConfig.hasReplicas()) {
    logger.warn(
      `List Parts Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(`List Parts Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
      break;
    }
  }

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `List Parts Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 200) {
    const errMessage = `List Parts Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`List Parts Successful: ${successResponse.statusText}`);
  }

  return response;
}

export async function abortMultipartUpload(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[S3 backend] Proxying Abort Multipart Upload Request...");

  const config: S3Config = bucketConfig.config as S3Config;

  const response = await forwardS3RequestToS3WithTimeouts(
    req,
    config,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Delete Object Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status != 204) {
    const errMesage =
      `Abort Multipart Upload Failed: ${successResponse.statusText}`;
    logger.warn(`Abort Multipart Upload Failed: ${successResponse.statusText}`);
    reportToSentry(errMesage);
  } else {
    logger.info(
      `Abort Multipart Upload Successful: ${successResponse.statusText}`,
    );
  }

  return response;
}
