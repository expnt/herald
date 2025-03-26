import { Context } from "@hono/hono";
import { forwardRequestWithTimeouts } from "../../utils/url.ts";
import { getLogger, reportToSentry } from "../../utils/log.ts";
import { S3Config } from "../../config/mod.ts";
import { prepareMirrorRequests } from "../mirror.ts";
import { Bucket } from "../../buckets/mod.ts";
import { swiftResolver } from "../swift/mod.ts";
import { s3Resolver } from "./mod.ts";
import { HeraldContext } from "../../types/mod.ts";
import { extractRequestInfo } from "../../utils/s3.ts";

const logger = getLogger(import.meta);

export async function getObject(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
) {
  logger.info("[S3 backend] Proxying Get Object Request...");

  let response = await forwardRequestWithTimeouts(
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
        ? await s3Resolver(ctx, req, replica)
        : await swiftResolver(ctx, req, replica);
      if (res instanceof Error) {
        logger.warn(`Get Object Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
    }
  }

  if (response instanceof Error) {
    logger.warn(`Get Object Failed: ${response.message}`);
    return response;
  }

  if (response.status !== 200) {
    const errMessage = `Get Object Failed: ${response.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Get Object Successful: ${response.statusText}`);
  }

  return response;
}

export async function listObjects(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
) {
  logger.info("[S3 backend] Proxying List Objects Request...");

  let response = await forwardRequestWithTimeouts(
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
        ? await s3Resolver(ctx, req, replica)
        : await swiftResolver(ctx, req, replica);
      if (res instanceof Error) {
        logger.warn(`List Objects Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
    }
  }

  if (response instanceof Error) {
    logger.warn(`List Objects Failed: ${response.message}`);
    return response;
  }

  if (response.status !== 200) {
    const errMessage = `List Objects Failed: ${response.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`List Objects Successful: ${response.statusText}`);
  }

  return response;
}

export async function putObject(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
) {
  logger.info("[S3 backend] Proxying Put Object Request...");

  const config: S3Config = bucketConfig.config as S3Config;
  const mirrorOperation = bucketConfig.hasReplicas();

  const response = await forwardRequestWithTimeouts(
    req,
    config,
  );

  if (response instanceof Error) {
    logger.warn(`Put Object Failed: ${response.message}`);
    return response;
  }

  if (response.status != 200) {
    const errMessage = `Put Object Failed: ${response.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Put Object Successful: ${response.statusText}`);
    const { queryParams } = extractRequestInfo(req);
    if (mirrorOperation && !queryParams["uploadId"]) {
      await prepareMirrorRequests(
        ctx,
        req,
        bucketConfig,
        "putObject",
      );
    }
  }

  return response;
}

export async function deleteObject(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
) {
  logger.info("[S3 backend] Proxying Delete Object Request...");

  const config: S3Config = bucketConfig.config as S3Config;
  const mirrorOperation = bucketConfig.hasReplicas();

  const response = await forwardRequestWithTimeouts(
    req,
    config,
  );

  if (response instanceof Error) {
    logger.warn(`Delete Object Failed: ${response.message}`);
    return response;
  }

  if (response.status != 204) {
    const errMesage = `Delete Object Failed: ${response.statusText}`;
    logger.warn(`Delete Object Failed: ${response.statusText}`);
    reportToSentry(errMesage);
  } else {
    logger.info(`Delete Object Successful: ${response.statusText}`);
    if (mirrorOperation) {
      await prepareMirrorRequests(
        ctx,
        req,
        bucketConfig,
        "deleteObject",
      );
    }
  }

  return response;
}

export async function copyObject(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
) {
  logger.info("[S3 backend] Proxying Copy Object Request...");

  const config: S3Config = bucketConfig.config as S3Config;
  const mirrorOperation = bucketConfig.hasReplicas();

  const response = await forwardRequestWithTimeouts(
    req,
    config,
  );

  if (response instanceof Error) {
    logger.warn(`Copy Object Failed: ${response.message}`);
    return response;
  }

  if (response.status != 200) {
    const errMessage = `Copy Object Failed: ${response.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Copy Object Successful: ${response.statusText}`);
    if (mirrorOperation) {
      await prepareMirrorRequests(
        ctx,
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
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
) {
  logger.info("[S3 backend] Proxying Head Object Request...");

  let response = await forwardRequestWithTimeouts(
    req,
    bucketConfig.config as S3Config,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    logger.warn(
      `Head Object Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(ctx, req, replica)
        : await swiftResolver(ctx, req, replica);
      if (res instanceof Error) {
        logger.warn(`Head Object Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
    }
  }

  if (response instanceof Error) {
    logger.warn(`Head Object Failed: ${response.message}`);
    return response;
  }

  if (response.status != 200) {
    const errMessage = `Head Object Failed: ${response.statusText}`;
    logger.warn(errMessage);
  } else {
    logger.info(`Head Object Successful: ${response.statusText}`);
  }

  return response;
}

export async function createMultipartUpload(
  _ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
) {
  logger.info("[S3 backend] Proxying Create Multipart Upload Request...");

  const response = await forwardRequestWithTimeouts(
    req,
    bucketConfig.config as S3Config,
  );

  if (response instanceof Error) {
    logger.warn(`Create Multipart Upload Failed: ${response.message}`);
    return response;
  }

  if (response.status !== 200) {
    const errMessage = `Create Multipart Upload Failed: ${response.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Create Multipart Upload Successful: ${response.statusText}`);
  }

  return response;
}

export async function completeMultipartUpload(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
) {
  logger.info("[S3 backend] Proxying Complete Multipart Upload Request...");

  const mirrorOperation = bucketConfig.hasReplicas();
  const response = await forwardRequestWithTimeouts(
    req,
    bucketConfig.config as S3Config,
  );

  if (response instanceof Error) {
    logger.warn(`Complete Multipart Upload Failed: ${response.message}`);
    return response;
  }

  if (response.status !== 200) {
    const errMessage =
      `Complete Multipart Upload Failed: ${response.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Complete Multipart Upload Successful: ${response.statusText}`);
    if (mirrorOperation) {
      await prepareMirrorRequests(
        ctx,
        req,
        bucketConfig,
        "completeMultipartUpload",
      );
    }
  }

  return response;
}

export async function listParts(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  logger.info("[S3 backend] Proxying List Parts Request...");

  let response = await forwardRequestWithTimeouts(
    req,
    bucketConfig.config as S3Config,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    logger.warn(
      `List Parts Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(ctx, req, replica)
        : await swiftResolver(ctx, req, replica);
      if (res instanceof Error) {
        logger.warn(`List Parts Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
    }
  }

  if (response instanceof Error) {
    logger.warn(`List Parts Failed: ${response.message}`);
    return response;
  }

  if (response.status !== 200) {
    const errMessage = `List Parts Failed: ${response.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`List Parts Successful: ${response.statusText}`);
  }

  return response;
}

export async function abortMultipartUpload(
  _ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  logger.info("[S3 backend] Proxying Abort Multipart Upload Request...");

  const config: S3Config = bucketConfig.config as S3Config;

  const response = await forwardRequestWithTimeouts(
    req,
    config,
  );

  if (response instanceof Error) {
    logger.warn(`Delete Object Failed: ${response.message}`);
    return response;
  }

  if (response.status != 204) {
    const errMesage = `Abort Multipart Upload Failed: ${response.statusText}`;
    logger.warn(`Abort Multipart Upload Failed: ${response.statusText}`);
    reportToSentry(errMesage);
  } else {
    logger.info(`Abort Multipart Upload Successful: ${response.statusText}`);
  }

  return response;
}
