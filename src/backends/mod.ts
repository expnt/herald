import { HeraldContext } from "./../types/mod.ts";
import { Context } from "@hono/hono";
import { getBucket } from "../config/loader.ts";
import { HTTPException } from "../types/http-exception.ts";
import { getBackendDef } from "../config/mod.ts";
import { s3Resolver } from "./s3/mod.ts";
import { swiftResolver } from "./swift/mod.ts";
import { extractRequestInfo } from "../utils/s3.ts";
import { getLogger } from "../utils/log.ts";
import { getAuthType, hasBucketAccess } from "../auth/mod.ts";

const logger = getLogger(import.meta);

export async function resolveHandler(
  ctx: HeraldContext,
  c: Context,
  serviceAccountName: string,
) {
  logger.debug("Resolving Handler for Request...");
  const reqInfo = extractRequestInfo(c.req.raw);
  const { bucket: bucketName } = reqInfo;

  if (!bucketName) {
    logger.critical("Bucket not specified in the request");
    throw new HTTPException(400, {
      message: "Bucket not specified in the request",
    });
  }

  const auth = getAuthType();
  if (auth !== "none" && !hasBucketAccess(serviceAccountName, bucketName)) {
    logger.critical(
      `Service Account: ${serviceAccountName} does not have access to bucket: ${bucketName}`,
    );
    throw new HTTPException(403, {
      message: `Access Denied:
        Service Account: ${serviceAccountName} does not have access to bucket: ${bucketName}`,
    });
  }

  const bucket = getBucket(bucketName);
  if (!bucket) {
    logger.critical(`Bucket Configuration missing for bucket: ${bucketName}`);
    throw new HTTPException(404, {
      message: `Bucket Configuration missing for bucket: ${bucketName}`,
    });
  }

  const backendName = bucket.backend;
  const bucketBackendDef = getBackendDef(backendName);

  const protocol = bucketBackendDef.protocol;
  const response = protocol === "s3"
    ? await s3Resolver(ctx, c.req.raw, bucket)
    : await swiftResolver(ctx, c.req.raw, bucket);

  if (response instanceof Error) {
    const httpException = response instanceof Error
      ? new HTTPException(500, {
        message: response.message,
      })
      : response;
    throw httpException;
  }

  return response;
}
