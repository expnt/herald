import { getSwiftRequestHeaders } from "./auth.ts";
import { HTTPException } from "../../types/http-exception.ts";
import { s3Utils } from "../../utils/mod.ts";
import { getLogger, reportToSentry } from "../../utils/log.ts";
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
  swiftResolver,
} from "./mod.ts";
import { HeraldContext } from "../../types/mod.ts";

const logger = getLogger(import.meta);

export async function createBucket(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  logger.info("[Swift backend] Proxying Create Bucket Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return new HTTPException(404, {
      message: "Bucket information missing from the request",
    });
  }

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;
  const mirrorOperation = bucketConfig.hasReplicas();

  const res = ctx.keystoneStore.getConfigAuthMeta(config);

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

  if (response instanceof Error) {
    logger.warn(`Create Bucket Failed: ${response.message}`);
    return response;
  }

  if (response.status >= 300) {
    const errMesage = `Create bucket Failed: ${response.statusText}`;
    logger.warn(errMesage);
    reportToSentry(errMesage);
  } else {
    logger.info(`Create bucket Successful: ${response.statusText}`);
    if (mirrorOperation) {
      await prepareMirrorRequests(
        ctx,
        req,
        bucketConfig,
        "createBucket",
      );
    }
  }

  return convertSwiftCreateBucketToS3Response(response, bucket);
}

export async function deleteBucket(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  logger.info("[Swift backend] Proxying Delete Bucket Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return new HTTPException(404, {
      message: "Bucket information missing from the request",
    });
  }

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;
  const mirrorOperation = bucketConfig.hasReplicas();

  const res = ctx.keystoneStore.getConfigAuthMeta(config);

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

  if (response instanceof Error) {
    logger.warn(`Delete Bucket Failed: ${response.message}`);
    return response;
  }

  if (response.status !== 204) {
    const errMessage = `Delete bucket Failed: ${response.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Delete bucket Successful: ${response.statusText}`);
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

export async function getBucketAcl(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  logger.info("[Swift backend] Handling Get Bucket ACL Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return new HTTPException(404, {
      message: "Bucket information missing from the request",
    });
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = ctx.keystoneStore.getConfigAuthMeta(config);

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

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    logger.warn(`Get Bucket ACL on Primary Bucket: ${bucketConfig.bucketName}`);
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(ctx, req, replica)
        : await swiftResolver(ctx, req, replica);
      if (res instanceof Error) {
        logger.warn(`Get bucket ACL Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
    }
  }

  if (response instanceof Error) {
    logger.warn(`Get bucket ACL Failed: ${response.message}`);
    return response;
  }

  if (response.status >= 300) {
    const errMessage = `Get bucket ACL Failed: ${response.statusText}`;
    logger.warn(errMessage);
    return new HTTPException(response.status, { message: response.statusText });
  }

  // Extract relevant headers from Swift response
  const owner = response.headers.get("X-Container-Meta-Owner") || "SwiftOwner";
  const readACL = response.headers.get("X-Container-Read") || "";
  const writeACL = response.headers.get("X-Container-Write") || "";

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

  return new Response(aclResponse, {
    status: 200,
    headers: { "Content-Type": XML_CONTENT_TYPE },
  });
}

export async function getBucketVersioning(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  logger.info("[Swift backend] Handling Get Bucket Versioning Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return new HTTPException(404, {
      message: "Bucket information missing from the request",
    });
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = ctx.keystoneStore.getConfigAuthMeta(config);

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

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    logger.warn(
      `Get Bucket Versioning on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(ctx, req, replica)
        : await swiftResolver(ctx, req, replica);
      if (res instanceof Error) {
        logger.warn(
          `Get bucket versioning Failed on Replica: ${replica.name}`,
        );
        continue;
      }
      response = res;
    }
  }

  if (response instanceof Error) {
    logger.warn(`Get bucket versioning Failed: ${response.message}`);
    return response;
  }

  if (response.status >= 300) {
    logger.warn(`Get bucket versioning Failed: ${response.statusText}`);
    return new HTTPException(response.status, { message: response.statusText });
  }

  // Swift doesn't support bucket versioning like S3, so we return an empty configuration
  const versioningResponse = `<?xml version="1.0" encoding="UTF-8"?>
<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</VersioningConfiguration>`;

  return new Response(versioningResponse, {
    status: 200,
    headers: { "Content-Type": XML_CONTENT_TYPE },
  });
}

export function getBucketAccelerate(
  _ctx: HeraldContext,
  _req: Request,
  _bucketConfig: Bucket,
): Response | Error {
  logger.info("[Swift backend] Handling Get Bucket Accelerate Request...");

  // Swift doesn't have an equivalent to S3's transfer acceleration
  // We'll return a response indicating acceleration is not configured
  const accelerateResponse = `<?xml version="1.0" encoding="UTF-8"?>
<AccelerateConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</AccelerateConfiguration>`;

  return new Response(accelerateResponse, {
    status: 200,
    headers: { "Content-Type": XML_CONTENT_TYPE },
  });
}

export function getBucketLogging(
  _ctx: HeraldContext,
  _req: Request,
  _bucketConfig: Bucket,
): Response | Error {
  logger.info("[Swift backend] Handling Get Bucket Logging Request...");

  // Swift doesn't have built-in bucket logging like S3
  // We'll return a response indicating logging is not enabled
  const loggingResponse = `<?xml version="1.0" encoding="UTF-8"?>
<BucketLoggingStatus xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</BucketLoggingStatus>`;

  return new Response(loggingResponse, {
    status: 200,
    headers: { "Content-Type": XML_CONTENT_TYPE },
  });
}

export function getBucketLifecycle(
  _ctx: HeraldContext,
  _req: Request,
  _bucketConfig: Bucket,
): Response | Error {
  logger.info("[Swift backend] Handling Get Bucket Lifecycle Request...");

  // Swift doesn't have a direct equivalent to S3's lifecycle policies
  // We'll return a response indicating no lifecycle rules are configured
  const lifecycleResponse = `<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</LifecycleConfiguration>`;

  return new Response(lifecycleResponse, {
    status: 200,
    headers: { "Content-Type": XML_CONTENT_TYPE },
  });
}

export function getBucketWebsite(
  _ctx: HeraldContext,
  _req: Request,
  _bucketConfig: Bucket,
): Response | Error {
  logger.info("[Swift backend] Handling Get Bucket Website Request...");

  // Swift doesn't have built-in static website hosting like S3
  // We'll return a response indicating that website hosting is not configured
  const websiteResponse = `<?xml version="1.0" encoding="UTF-8"?>
<WebsiteConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</WebsiteConfiguration>`;

  return new Response(websiteResponse, {
    status: 200,
    headers: { "Content-Type": XML_CONTENT_TYPE },
  });
}

export function getBucketPayment(
  _ctx: HeraldContext,
  _req: Request,
  _bucketConfig: Bucket,
): Response | Error {
  logger.info("[Swift backend] Handling Get Bucket Payment Request...");

  // Swift doesn't have a concept of requester pays like S3
  // We'll return a MethodNotAllowed response
  throw MethodNotAllowedException("GET");
}

export async function getBucketEncryption(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  logger.info("[Swift backend] Handling Get Bucket Encryption Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return new HTTPException(404, {
      message: "Bucket information missing from the request",
    });
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = ctx.keystoneStore.getConfigAuthMeta(config);

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

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    logger.warn(
      `Get Bucket Encryption on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(ctx, req, replica)
        : await swiftResolver(ctx, req, replica);
      if (res instanceof Error) {
        logger.warn(
          `Get bucket encryption Failed on Replica: ${replica.name}`,
        );
        continue;
      }
      response = res;
    }
  }

  if (response instanceof Error) {
    logger.warn(`Get bucket encryption Failed: ${response.message}`);
    return response;
  }

  if (response.status >= 300) {
    logger.warn(`Get bucket encryption Failed: ${response.statusText}`);
    return new HTTPException(response.status, { message: response.statusText });
  }

  // Check if Swift container has encryption enabled
  const encryptionEnabled =
    response.headers.get("X-Container-Meta-Encryption-Type") !== null;

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

  return new Response(encryptionResponse, {
    status: 200,
    headers: { "Content-Type": XML_CONTENT_TYPE },
  });
}

export async function headBucket(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  logger.info("[Swift backend] Proxying Head Bucket Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return new HTTPException(404, {
      message: "Bucket information missing from the request",
    });
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = ctx.keystoneStore.getConfigAuthMeta(config);

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
        logger.warn(
          `Head bucket Failed on Replica: ${replica.name}`,
        );
        continue;
      }
      response = res;
    }
  }

  if (response instanceof Error) {
    logger.warn(`Head bucket Failed: ${response.message}`);
    const errorXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${response.name}</Code>
  <Message>${response.message}.</Message>
</Error>`;

    return new Response(errorXml, {
      status: 500,
      headers: {
        "Content-Type": "application/xml",
      },
    });
  }

  logger.info(`Head bucket Successful: ${response.statusText}`);

  if (response.status >= 300) {
    return new Response(null, {
      status: response.status,
      headers: response.headers,
    });
  }

  return convertSwiftHeadBucketToS3Response(response, config.region);
}

export function getBucketCors(
  _ctx: HeraldContext,
  _req: Request,
  _bucketConfig: Bucket,
): Response | Error {
  logger.info("[Swift backend] Handling Get Bucket CORS Request...");

  // Swift doesn't have a direct equivalent to S3's CORS configuration
  // We'll return an empty CORS configuration
  const corsResponse = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</CORSConfiguration>`;

  return new Response(corsResponse, {
    status: 200,
    headers: { "Content-Type": XML_CONTENT_TYPE },
  });
}

export function getBucketReplication(
  _ctx: HeraldContext,
  _req: Request,
  _bucketConfig: Bucket,
): Response | Error {
  logger.info("[Swift backend] Handling Get Bucket Replication Request...");

  // Swift doesn't have a built-in replication feature like S3
  // We'll return an empty replication configuration
  const replicationResponse = `<?xml version="1.0" encoding="UTF-8"?>
<ReplicationConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</ReplicationConfiguration>`;

  return new Response(replicationResponse, {
    status: 200,
    headers: { "Content-Type": XML_CONTENT_TYPE },
  });
}

export function getBucketObjectLock(
  _ctx: HeraldContext,
  _req: Request,
  _bucketConfig: Bucket,
): Response | Error {
  logger.info("[Swift backend] Handling Get Bucket Object Lock Request...");

  // Swift doesn't have an equivalent to S3's Object Lock feature
  // We'll return an empty Object Lock configuration
  const objectLockResponse = `<?xml version="1.0" encoding="UTF-8"?>
<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</ObjectLockConfiguration>`;

  return new Response(objectLockResponse, {
    status: 200,
    headers: { "Content-Type": XML_CONTENT_TYPE },
  });
}

export async function getBucketTagging(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  logger.info("[Swift backend] Handling Get Bucket Tagging Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return new HTTPException(404, {
      message: "Bucket information missing from the request",
    });
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = ctx.keystoneStore.getConfigAuthMeta(config);

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

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    logger.warn(
      `Get Bucket Tagging on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(ctx, req, replica)
        : await swiftResolver(ctx, req, replica);
      if (res instanceof Error) {
        logger.warn(
          `Get bucket tagging Failed on Replica: ${replica.name}`,
        );
        continue;
      }
      response = res;
    }
  }

  if (response instanceof Error) {
    logger.warn(`Get bucket tagging Failed: ${response.message}`);
    return response;
  }

  if (response.status >= 300) {
    logger.warn(`Get bucket tagging Failed: ${response.statusText}`);
    return new HTTPException(response.status, { message: response.statusText });
  }

  // Swift doesn't have a direct equivalent to S3's tagging
  // We'll check for custom metadata that could be used as tags
  const tags: { Key: string; Value: string }[] = [];
  for (const [key, value] of response.headers.entries()) {
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

  return new Response(taggingResponse, {
    status: 200,
    headers: { "Content-Type": XML_CONTENT_TYPE },
  });
}

export async function getBucketPolicy(
  ctx: HeraldContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Response | Error> {
  logger.info("[Swift backend] Handling Get Bucket Policy Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return new HTTPException(404, {
      message: "Bucket information missing from the request",
    });
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = ctx.keystoneStore.getConfigAuthMeta(config);

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

  if (response instanceof Error && bucketConfig.hasReplicas()) {
    logger.warn(
      `Get Bucket Policy on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(ctx, req, replica)
        : await swiftResolver(ctx, req, replica);
      if (res instanceof Error) {
        logger.warn(
          `Get bucket policy Failed on Replica: ${replica.name}`,
        );
        continue;
      }
      response = res;
    }
  }

  if (response instanceof Error) {
    logger.warn(`Get bucket policy Failed: ${response.message}`);
    return response;
  }

  if (response.status >= 300) {
    logger.warn(`Get bucket policy Failed: ${response.statusText}`);
    return new HTTPException(response.status, { message: response.statusText });
  }

  // Swift doesn't have a direct equivalent to S3's bucket policies
  // We'll return a simple policy based on the container's ACLs
  const readACL = response.headers.get("X-Container-Read") || "";
  const writeACL = response.headers.get("X-Container-Write") || "";

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

  return new Response(policyResponse, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
