import { Context } from "@hono/hono";
import { getBucketConfig } from "../config/loader.ts";
import { HTTPException } from "../types/http-exception.ts";
import {
  getBackendDef,
  S3BucketConfig,
  SwiftBucketConfig,
} from "../config/mod.ts";
import { s3Resolver } from "./s3/mod.ts";
import { swiftResolver } from "./swift/mod.ts";
import { extractRequestInfo } from "../utils/s3.ts";
import { getLogger } from "../utils/log.ts";

const logger = getLogger(import.meta);

export async function resolveHandler(c: Context, serviceAccountName: string) {
  logger.debug("Resolving Handler for Request...");
  const reqInfo = extractRequestInfo(c.req.raw);
  const { bucket } = reqInfo;

  if (serviceAccountName) {
    // TODO: implement authorization
  }

  if (!bucket) {
    logger.critical("Bucket not specified in the request");
    throw new HTTPException(400, {
      message: "Bucket not specified in the request",
    });
  }

  const bucketConfig = getBucketConfig(bucket);
  if (!bucketConfig) {
    logger.critical(`Bucket Configuration missing for bucket: ${bucket}`);
    throw new HTTPException(404, {
      message: `Bucket Configuration missing for bucket: ${bucket}`,
    });
  }

  const backendName = bucketConfig.backend;
  const bucketBackendDef = getBackendDef(backendName);
  if (!bucketBackendDef) {
    logger.critical(
      `Backend Configuration missing for backend with name: ${backendName} under bucket: ${bucket}`,
    );
    throw new HTTPException(404, {
      message:
        `Backend Configuration missing for backend with name: ${backendName} under bucket: ${bucket}`,
    });
  }

  const protocol = bucketBackendDef.protocol;
  if (protocol === "s3") {
    const s3Config = bucketConfig as S3BucketConfig;
    return await s3Resolver(c, s3Config);
  } else if (protocol === "swift") {
    const swiftConfig = bucketConfig as SwiftBucketConfig;
    return await swiftResolver(c, swiftConfig);
  } else {
    logger.critical(`Unsupported Backend Protocol: ${protocol}`);
    throw new HTTPException(400, { message: "Unsupported Backend Protocol" });
  }
}
