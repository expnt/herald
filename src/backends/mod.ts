import { RequestContext } from "./../types/mod.ts";
import { Context } from "@hono/hono";
import { getBucket } from "../config/loader.ts";
import { HeraldError } from "../types/http-exception.ts";
import { getBackendDef, globalConfig } from "../config/mod.ts";
import { s3Resolver } from "./s3/mod.ts";
import { swiftResolver } from "./swift/mod.ts";
import { extractRequestInfo } from "../utils/s3.ts";
import { getAuthType, hasBucketAccess } from "../auth/mod.ts";
import { verifyV4Signature } from "../utils/signer.ts";
import { APIErrors, getAPIErrorResponse } from "../types/api_errors.ts";

export async function resolveHandler(
  reqCtx: RequestContext,
  c: Context,
  serviceAccountName: string,
): Promise<Response> {
  const logger = reqCtx.logger;
  logger.debug("Resolving Handler for Request...");
  const reqInfo = extractRequestInfo(c.req.raw);
  const { bucket: bucketName } = reqInfo;

  if (!bucketName) {
    logger.critical("Bucket not specified in the request");
    return getAPIErrorResponse(APIErrors.ErrInvalidRequest);
  }

  await verifyV4Signature(
    c.req.raw,
    globalConfig.buckets[bucketName].config,
    {
      // FIXME: properly source the credential lists
    },
  );

  const auth = getAuthType();
  if (auth !== "none" && !hasBucketAccess(serviceAccountName, bucketName)) {
    logger.critical(
      `Service Account: ${serviceAccountName} does not have access to bucket: ${bucketName}`,
    );
    throw new HeraldError(403, {
      message: `Access Denied:
        Service Account: ${serviceAccountName} does not have access to bucket: ${bucketName}`,
    });
  }

  const bucket = getBucket(bucketName);
  if (!bucket) {
    logger.critical(`Bucket Configuration missing for bucket: ${bucketName}`);
    throw new HeraldError(404, {
      message: `Bucket Configuration missing for bucket: ${bucketName}`,
    });
  }

  const backendName = bucket.backend;
  const bucketBackendDef = getBackendDef(backendName);

  const protocol = bucketBackendDef.protocol;
  const response = protocol === "s3"
    ? await s3Resolver(reqCtx, c.req.raw, bucket)
    : await swiftResolver(reqCtx, c.req.raw, bucket);

  if (response instanceof HeraldError) {
    return response.getResponse();
  }

  if (response instanceof Error) {
    const errResponse = new HeraldError(500, {
      message: response.message,
    }).getResponse();
    return errResponse;
  }

  return response;
}
