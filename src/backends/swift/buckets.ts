import { getSwiftRequestHeaders } from "./auth.ts";
import { HeraldError } from "../../types/http-exception.ts";
import { s3Utils } from "../../utils/mod.ts";
import { reportToSentry } from "../../utils/log.ts";
import {
  getBodyFromReq,
  retryWithExponentialBackoff,
} from "../../utils/url.ts";
import { MethodNotAllowedException } from "../../constants/errors.ts";
import { XML_CONTENT_TYPE } from "../../constants/query-params.ts";
import { SwiftConfig } from "../../config/types.ts";
import { prepareMirrorRequests } from "../mirror.ts";
import { Bucket } from "../../buckets/mod.ts";
import { s3Resolver } from "../s3/mod.ts";
import {
  convertSwiftCreateBucketToS3Response,
  convertSwiftHeadBucketToS3Response,
  convertSwiftListBucketsToS3Response,
  swiftResolver,
} from "./mod.ts";
import { RequestContext } from "../../types/mod.ts";
import {
  createErr,
  createOk,
  isOk,
  Result,
  unwrapErr,
  unwrapOk,
} from "option-t/plain_result";

export async function listBuckets(
  reqCtx: RequestContext,
  _req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying List Buckets Request...");

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;

  // Get auth metadata (storage URL and token)
  const { storageUrl: swiftUrl, token: authToken } = reqCtx.heraldContext
    .keystoneStore.getConfigAuthMeta(config);

  const headers = getSwiftRequestHeaders(authToken);
  headers.set("accept", "application/json");

  // In Swift, listing buckets is a GET on the account URL (no bucket name)
  const reqUrl = swiftUrl;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "GET",
      headers: headers,
    });
  };

  const response = await retryWithExponentialBackoff(fetchFunc);

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `List Buckets Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const swiftRes = unwrapOk(response);

  if (swiftRes.status >= 300) {
    const errMessage = `List Buckets Failed: ${swiftRes.statusText}`;
    logger.warn(errMessage);
    return createErr(
      new HeraldError(swiftRes.status, {
        message: errMessage,
      }),
    );
  }

  // Convert Swift response to S3 ListBuckets XML
  const s3Response = await convertSwiftListBucketsToS3Response(swiftRes);

  logger.info("List Buckets Successful", s3Response.statusText);

  return createOk(
    s3Response,
  );
}

export async function createBucket(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Create Bucket Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createErr(
      new HeraldError(404, {
        message: "Bucket information missing from the request",
      }),
    );
  }

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;
  const mirrorOperation = bucketConfig.hasReplicas();

  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "PUT",
      headers: headers,
      body: getBodyFromReq(req),
    });
  };
  const response = await retryWithExponentialBackoff(
    fetchFunc,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Create Bucket Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status >= 300) {
    const errMesage = `Create bucket Failed: ${successResponse.statusText}`;
    logger.warn(errMesage);
    reportToSentry(errMesage);
  } else {
    logger.info(`Create bucket Successful: ${successResponse.statusText}`);
    if (mirrorOperation) {
      await prepareMirrorRequests(
        reqCtx,
        req,
        bucketConfig,
        "createBucket",
      );
    }
  }

  return convertSwiftCreateBucketToS3Response(successResponse, bucket);
}

export async function deleteBucket(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Delete Bucket Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createErr(
      new HeraldError(404, {
        message: "Bucket information missing from the request",
      }),
    );
  }

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;
  const mirrorOperation = bucketConfig.hasReplicas();

  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "Delete",
      headers: headers,
      body: getBodyFromReq(req),
    });
  };
  const response = await retryWithExponentialBackoff(
    fetchFunc,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Delete Bucket Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 204) {
    const errMessage = `Delete bucket Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Delete bucket Successful: ${successResponse.statusText}`);
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

export async function getBucketAcl(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket ACL Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createErr(
      new HeraldError(404, {
        message: "Bucket information missing from the request",
      }),
    );
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "HEAD",
      headers: headers,
    });
  };

  let response = await retryWithExponentialBackoff(
    fetchFunc,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (!isOk(response) && bucketConfig.hasReplicas()) {
    logger.warn(
      `Get Bucket ACL on Primary Bucket Failed: ${bucketConfig.bucketName}`,
      response,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (!isOk(res)) {
        const errRes = unwrapErr(res);
        logger.warn(
          `Get bucket ACL Failed on Replica: ${replica.name} -- ${errRes.message}`,
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
      `Get bucket ACL Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status >= 300) {
    const errMessage = `Get bucket ACL Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    return createErr(
      new HeraldError(successResponse.status, {
        message: successResponse.statusText,
      }),
    );
  }

  // Extract relevant headers from Swift response
  const owner = successResponse.headers.get("X-Container-Meta-Owner") ||
    "SwiftOwner";
  const readACL = successResponse.headers.get("X-Container-Read") || "";
  const writeACL = successResponse.headers.get("X-Container-Write") || "";

  // Construct S3-like ACL response based on Swift headers
  const aclResponse = `<?xml version="1.0" encoding="UTF-8"?>
<AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner>
    <ID>${owner}</ID>
    <DisplayName>${owner}</DisplayName>
  </Owner>
  <AccessControlList>
    <Grant>
      <Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser">
        <ID>${owner}</ID>
        <DisplayName>${owner}</DisplayName>
      </Grantee>
      <Permission>FULL_CONTROL</Permission>
    </Grant>
    ${
    readACL
      ? `<Grant><Grantee xsi:type="Group"><URI>${readACL}</URI></Grantee><Permission>READ</Permission></Grant>`
      : ""
  }
    ${
    writeACL
      ? `<Grant><Grantee xsi:type="Group"><URI>${writeACL}</URI></Grantee><Permission>WRITE</Permission></Grant>`
      : ""
  }
  </AccessControlList>
</AccessControlPolicy>`;

  return createOk(
    new Response(aclResponse, {
      status: 200,
      headers: { "Content-Type": XML_CONTENT_TYPE },
    }),
  );
}

export async function getBucketVersioning(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket Versioning Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createErr(
      new HeraldError(404, {
        message: "Bucket information missing from the request",
      }),
    );
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "HEAD",
      headers: headers,
    });
  };

  let response = await retryWithExponentialBackoff(
    fetchFunc,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (!isOk(response) && bucketConfig.hasReplicas()) {
    logger.warn(
      `Get Bucket Versioning on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(
          `Get bucket versioning Failed on Replica: ${replica.name}`,
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
      `Get bucket versioning Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status >= 300) {
    logger.warn(`Get bucket versioning Failed: ${successResponse.statusText}`);
    return createErr(
      new HeraldError(successResponse.status, {
        message: successResponse.statusText,
      }),
    );
  }

  // Swift doesn't support bucket versioning like S3, so we return an empty configuration
  const versioningResponse = `<?xml version="1.0" encoding="UTF-8"?>
<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</VersioningConfiguration>`;

  return createOk(
    new Response(versioningResponse, {
      status: 200,
      headers: { "Content-Type": XML_CONTENT_TYPE },
    }),
  );
}

export function getBucketAccelerate(
  reqCtx: RequestContext,
  _req: Request,
  _bucketConfig: Bucket,
): Result<Response, Error> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket Accelerate Request...");

  // Swift doesn't have an equivalent to S3's transfer acceleration
  // We'll return a response indicating acceleration is not configured
  const accelerateResponse = `<?xml version="1.0" encoding="UTF-8"?>
<AccelerateConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</AccelerateConfiguration>`;

  return createOk(
    new Response(accelerateResponse, {
      status: 200,
      headers: { "Content-Type": XML_CONTENT_TYPE },
    }),
  );
}

export function getBucketLogging(
  reqCtx: RequestContext,
  _req: Request,
  _bucketConfig: Bucket,
): Result<Response, Error> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket Logging Request...");

  // Swift doesn't have built-in bucket logging like S3
  // We'll return a response indicating logging is not enabled
  const loggingResponse = `<?xml version="1.0" encoding="UTF-8"?>
<BucketLoggingStatus xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</BucketLoggingStatus>`;

  return createOk(
    new Response(loggingResponse, {
      status: 200,
      headers: { "Content-Type": XML_CONTENT_TYPE },
    }),
  );
}

export function getBucketLifecycle(
  reqCtx: RequestContext,
  _req: Request,
  _bucketConfig: Bucket,
): Result<Response, Error> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket Lifecycle Request...");

  // Swift doesn't have a direct equivalent to S3's lifecycle policies
  // We'll return a response indicating no lifecycle rules are configured
  const lifecycleResponse = `<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</LifecycleConfiguration>`;

  return createOk(
    new Response(lifecycleResponse, {
      status: 200,
      headers: { "Content-Type": XML_CONTENT_TYPE },
    }),
  );
}

export function getBucketWebsite(
  reqCtx: RequestContext,
  _req: Request,
  _bucketConfig: Bucket,
): Result<Response, Error> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket Website Request...");

  // Swift doesn't have built-in static website hosting like S3
  // We'll return a response indicating that website hosting is not configured
  const websiteResponse = `<?xml version="1.0" encoding="UTF-8"?>
<WebsiteConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</WebsiteConfiguration>`;

  return createOk(
    new Response(websiteResponse, {
      status: 200,
      headers: { "Content-Type": XML_CONTENT_TYPE },
    }),
  );
}

export function getBucketPayment(
  reqCtx: RequestContext,
  _req: Request,
  _bucketConfig: Bucket,
): Result<Response, Error> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket Payment Request...");

  // Swift doesn't have a concept of requester pays like S3
  // We'll return a MethodNotAllowed response
  return createOk(MethodNotAllowedException("GET"));
}

export async function getBucketEncryption(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket Encryption Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createErr(
      new HeraldError(404, {
        message: "Bucket information missing from the request",
      }),
    );
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "HEAD",
      headers: headers,
    });
  };

  let response = await retryWithExponentialBackoff(
    fetchFunc,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (!isOk(response) && bucketConfig.hasReplicas()) {
    logger.warn(
      `Get Bucket Encryption on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(
          `Get bucket encryption Failed on Replica: ${replica.name}`,
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
      `Get bucket encryption Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status >= 300) {
    logger.warn(`Get bucket encryption Failed: ${successResponse.statusText}`);
    return createErr(
      new HeraldError(successResponse.status, {
        message: successResponse.statusText,
      }),
    );
  }

  // Check if Swift container has encryption enabled
  const encryptionEnabled =
    successResponse.headers.get("X-Container-Meta-Encryption-Type") !== null;

  const encryptionResponse = `<?xml version="1.0" encoding="UTF-8"?>
<ServerSideEncryptionConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  ${
    encryptionEnabled
      ? `
  <Rule>
    <ApplyServerSideEncryptionByDefault>
      <SSEAlgorithm>AES256</SSEAlgorithm>
    </ApplyServerSideEncryptionByDefault>
  </Rule>
  `
      : ""
  }
</ServerSideEncryptionConfiguration>`;

  return createOk(
    new Response(encryptionResponse, {
      status: 200,
      headers: { "Content-Type": XML_CONTENT_TYPE },
    }),
  );
}

export async function headBucket(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Head Bucket Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createErr(
      new HeraldError(404, {
        message: "Bucket information missing from the request",
      }),
    );
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "HEAD",
      headers: headers,
    });
  };

  let response = await retryWithExponentialBackoff(
    fetchFunc,
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
        logger.warn(
          `Head bucket Failed on Replica: ${replica.name}`,
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
      `Head bucket Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  logger.info(`Head bucket Successful: ${successResponse.statusText}`);

  if (successResponse.status >= 300) {
    return createOk(
      new Response(null, {
        status: successResponse.status,
        headers: successResponse.headers,
      }),
    );
  }

  return convertSwiftHeadBucketToS3Response(successResponse, config.region);
}

export function getBucketCors(
  reqCtx: RequestContext,
  _req: Request,
  _bucketConfig: Bucket,
): Result<Response, Error> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket CORS Request...");

  // Swift doesn't have a direct equivalent to S3's CORS configuration
  // We'll return an empty CORS configuration
  const corsResponse = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</CORSConfiguration>`;

  return createOk(
    new Response(corsResponse, {
      status: 200,
      headers: { "Content-Type": XML_CONTENT_TYPE },
    }),
  );
}

export function getBucketReplication(
  reqCtx: RequestContext,
  _req: Request,
  _bucketConfig: Bucket,
): Result<Response, Error> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket Replication Request...");

  // Swift doesn't have a built-in replication feature like S3
  // We'll return an empty replication configuration
  const replicationResponse = `<?xml version="1.0" encoding="UTF-8"?>
<ReplicationConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</ReplicationConfiguration>`;

  return createOk(
    new Response(replicationResponse, {
      status: 200,
      headers: { "Content-Type": XML_CONTENT_TYPE },
    }),
  );
}

export function getBucketObjectLock(
  reqCtx: RequestContext,
  _req: Request,
  _bucketConfig: Bucket,
): Result<Response, Error> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket Object Lock Request...");

  // Swift doesn't have an equivalent to S3's Object Lock feature
  // We'll return an empty Object Lock configuration
  const objectLockResponse = `<?xml version="1.0" encoding="UTF-8"?>
<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</ObjectLockConfiguration>`;

  return createOk(
    new Response(objectLockResponse, {
      status: 200,
      headers: { "Content-Type": XML_CONTENT_TYPE },
    }),
  );
}

export async function getBucketTagging(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket Tagging Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createErr(
      new HeraldError(404, {
        message: "Bucket information missing from the request",
      }),
    );
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "HEAD",
      headers: headers,
    });
  };

  let response = await retryWithExponentialBackoff(
    fetchFunc,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (!isOk(response) && bucketConfig.hasReplicas()) {
    logger.warn(
      `Get Bucket Tagging on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(
          `Get bucket tagging Failed on Replica: ${replica.name}`,
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
      `Get bucket tagging Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status >= 300) {
    logger.warn(`Get bucket tagging Failed: ${successResponse.statusText}`);
    return createErr(
      new HeraldError(successResponse.status, {
        message: successResponse.statusText,
      }),
    );
  }

  // Swift doesn't have a direct equivalent to S3's tagging
  // We'll check for custom metadata that could be used as tags
  const tags: { Key: string; Value: string }[] = [];
  for (const [key, value] of successResponse.headers.entries()) {
    if (key.toLowerCase().startsWith("x-container-meta-tag-")) {
      const tagKey = key.slice("x-container-meta-tag-".length);
      tags.push({ Key: tagKey, Value: value });
    }
  }

  const taggingResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <TagSet>
    ${
    tags.map((tag) => `
    <Tag>
      <Key>${tag.Key}</Key>
      <Value>${tag.Value}</Value>
    </Tag>`).join("")
  }
  </TagSet>
</Tagging>`;

  return createOk(
    new Response(taggingResponse, {
      status: 200,
      headers: { "Content-Type": XML_CONTENT_TYPE },
    }),
  );
}

export async function getBucketPolicy(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Handling Get Bucket Policy Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createErr(
      new HeraldError(404, {
        message: "Bucket information missing from the request",
      }),
    );
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "HEAD",
      headers: headers,
    });
  };

  let response = await retryWithExponentialBackoff(
    fetchFunc,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (!isOk(response) && bucketConfig.hasReplicas()) {
    logger.warn(
      `Get Bucket Policy on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(
          `Get bucket policy Failed on Replica: ${replica.name}`,
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
      `Get Bucket Policy Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status >= 300) {
    logger.warn(`Get bucket policy Failed: ${successResponse.statusText}`);
    return createErr(
      new HeraldError(successResponse.status, {
        message: successResponse.statusText,
      }),
    );
  }

  // Swift doesn't have a direct equivalent to S3's bucket policies
  // We'll return a simple policy based on the container's ACLs
  const readACL = successResponse.headers.get("X-Container-Read") || "";
  const writeACL = successResponse.headers.get("X-Container-Write") || "";

  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PublicRead",
        Effect: readACL.includes(".r:*") ? "Allow" : "Deny",
        Principal: "*",
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
      {
        Sid: "PublicWrite",
        Effect: writeACL.includes(".r:*") ? "Allow" : "Deny",
        Principal: "*",
        Action: ["s3:PutObject"],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  };

  const policyResponse = JSON.stringify(policy, null, 2);

  return createOk(
    new Response(policyResponse, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}
