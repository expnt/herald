import {
  formatParams,
  forwardS3RequestToS3WithTimeouts,
} from "../../utils/url.ts";
import { getLogger, reportToSentry } from "../../utils/log.ts";
import { S3Config } from "../../config/mod.ts";
import { prepareMirrorRequests } from "../mirror.ts";
import { Bucket } from "../../buckets/mod.ts";
import { s3Resolver } from "./mod.ts";
import { swiftResolver } from "../swift/mod.ts";
import { HeraldContext } from "../../types/mod.ts";

const logger = getLogger(import.meta);

export async function createBucket(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
) {
  logger.info("[S3 backend] Proxying Create Bucket Request...");

  const config: S3Config = bucketConfig.config as S3Config;
  const mirrorOperation = bucketConfig.hasReplicas();

  const response = await forwardS3RequestToS3WithTimeouts(
    req,
    config,
  );

  if (response instanceof Error) {
    logger.warn(`Create Bucket Failed: ${response.message}`);
    return response;
  }

  if (response.status != 200) {
    const errMessage = `Create Bucket Failed: ${response.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Create Bucket Successful: ${response.statusText}`);
    if (mirrorOperation) {
      await prepareMirrorRequests(
        ctx,
        req,
        bucketConfig,
        "createBucket",
      );
    }
  }

  return response;
}

export async function deleteBucket(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
) {
  logger.info("[S3 backend] Proxying Delete Bucket Request...");

  const config: S3Config = bucketConfig.config as S3Config;
  const mirrorOperation = bucketConfig.hasReplicas();

  const response = await forwardS3RequestToS3WithTimeouts(
    req,
    config,
  );

  if (response instanceof Error) {
    logger.warn(`Delete Bucket Failed: ${response.message}`);
    return response;
  }

  if (response.status != 204) {
    const errMessage = `Delete Bucket Failed: ${response.statusText}`;
    reportToSentry(errMessage);
    logger.warn(errMessage);
  } else {
    logger.info(`Delete Bucket Successful: ${response.statusText}`);
    if (mirrorOperation) {
      await prepareMirrorRequests(
        ctx,
        req,
        bucketConfig,
        "deleteBucket",
      );
    }
  }

  return response;
}

export async function routeQueryParamedRequest(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
  queryParams: Set<string>,
) {
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
        ? await s3Resolver(ctx, req, replica)
        : await swiftResolver(ctx, req, replica);
      if (res instanceof Error) {
        logger.warn(
          `${formattedParams} Operation Failed on Replica: ${replica.name}`,
        );
        continue;
      }
      response = res;
    }
  }

  if (response instanceof Error) {
    logger.warn(`${formatParams} Operation Failed: ${response.message}`);
    return response;
  }

  if (response.status != 200) {
    const errMessage =
      `Get Bucket ${formattedParams} Failed: ${response.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(
      `Get Bucket ${formattedParams} Successful: ${response.statusText}`,
    );
  }

  return response;
}

export async function headBucket(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  logger.info(`[S3 backend] Proxying Head Bucket Request...`);

  let response = await forwardS3RequestToS3WithTimeouts(
    req,
    bucketConfig.config as S3Config,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    logger.warn(
      `Head Bucket Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(ctx, req, replica)
        : await swiftResolver(ctx, req, replica);
      if (res instanceof Error) {
        logger.warn(`Head Bucket Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
    }
  }

  if (response instanceof Error) {
    logger.warn(`Head Bucket Failed: ${response.message}`);
    return response;
  }

  if (response.status != 200) {
    const errMessage = `Head Bucket Failed: ${response.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(
      `Head Bucket Successful: ${response.statusText}`,
    );
  }

  return response;
}
