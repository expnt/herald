import { formatParams, forwardRequestWithTimeouts } from "../../utils/url.ts";
import { getLogger, reportToSentry } from "../../utils/log.ts";
import { S3BucketConfig, S3Config } from "../../config/mod.ts";
import { prepareMirrorRequests } from "../mirror.ts";
import { Bucket } from "../../buckets/mod.ts";
import { s3Resolver } from "./mod.ts";
import { swiftResolver } from "../swift/mod.ts";

const logger = getLogger(import.meta);

export async function createBucket(
  req: Request,
  bucketConfig: Bucket,
) {
  logger.info("[S3 backend] Proxying Create Bucket Request...");

  const config: S3Config = bucketConfig.config as S3Config;
  const mirrorOperation = bucketConfig.hasReplicas();

  const response = await forwardRequestWithTimeouts(
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
        req,
        bucketConfig as S3BucketConfig,
        "createBucket",
      );
    }
  }

  return response;
}

export async function deleteBucket(
  req: Request,
  bucketConfig: Bucket,
) {
  logger.info("[S3 backend] Proxying Delete Bucket Request...");

  const config: S3Config = bucketConfig.config as S3Config;
  const mirrorOperation = bucketConfig.hasReplicas();

  const response = await forwardRequestWithTimeouts(
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
        req,
        bucketConfig as S3BucketConfig,
        "deleteBucket",
      );
    }
  }

  return response;
}

export async function routeQueryParamedRequest(
  req: Request,
  bucketConfig: Bucket,
  queryParams: string[],
) {
  const formattedParams = formatParams(queryParams);
  logger.info(`[S3 backend] Proxying Get Bucket ${formattedParams} Request...`);

  let response = await forwardRequestWithTimeouts(
    req,
    bucketConfig.config as S3Config,
  );

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(req, replica)
        : await swiftResolver(req, replica);
      if (res instanceof Error) {
        logger.warn(
          `${formatParams} Operation Failed on Replica: ${replica.name}`,
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
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  logger.info(`[S3 backend] Proxying Head Bucket Request...`);

  let response = await forwardRequestWithTimeouts(
    req,
    bucketConfig.config as S3Config,
  );

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(req, replica)
        : await swiftResolver(req, replica);
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
