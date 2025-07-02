import * as xml2js from "xml2js";

import { reportToSentry } from "../../utils/log.ts";
import { HeraldError } from "../../types/http-exception.ts";
import { getSwiftRequestHeaders } from "./auth.ts";
import {
  getBodyBuffer,
  getBodyFromReq,
  retryWithExponentialBackoff,
} from "../../utils/url.ts";
import { toS3ListPartXmlContent, toS3XmlContent } from "./utils/mod.ts";
import {
  InternalServerErrorException,
  InvalidRequestException,
  MissingUploadIdException,
  NoSuchBucketException,
  NotImplementedException,
} from "../../constants/errors.ts";
import { SwiftConfig } from "../../config/types.ts";
import { S3_COPY_SOURCE_HEADER } from "../../constants/headers.ts";
import { s3Utils } from "../../utils/mod.ts";
import { prepareMirrorRequests } from "../mirror.ts";
import { Bucket } from "../../buckets/mod.ts";
import { s3Resolver } from "../s3/mod.ts";
import {
  convertSwiftCopyObjectToS3Response,
  convertSwiftDeleteObjectToS3Response,
  convertSwiftGetObjectToS3Response,
  convertSwiftHeadObjectToS3Response,
  convertSwiftPutObjectToS3Response,
  convertSwiftUploadPartToS3Response,
  swiftResolver,
} from "./mod.ts";
import { RequestContext } from "../../types/mod.ts";
import { getRandomUUID } from "../../utils/crypto.ts";
import { MULTIPART_UPLOADS_PATH } from "../../constants/s3.ts";
import { APIErrors, getAPIErrorResponse } from "../../types/api_errors.ts";
import {
  createErr,
  createOk,
  isOk,
  Result,
  unwrapErr,
  unwrapOk,
} from "option-t/plain_result";

export async function putObject(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Put Object Request...");
  const { bucket, objectKey: object } = s3Utils.extractRequestInfo(req);
  const body = req.body;
  if (!bucket) {
    return createOk(InvalidRequestException(
      "Bucket information missing from the request",
    ));
  }

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;
  const mirrorOperation = bucketConfig.hasReplicas();

  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}/${object}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "PUT",
      headers: headers,
      body: body,
    });
  };
  const response = await retryWithExponentialBackoff(
    fetchFunc,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Put Object Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 201) {
    const errMessage = `Put Object Failed: ${successResponse.statusText}`;
    logger.warn(errMessage, { successResponse });
    reportToSentry(errMessage);
  } else {
    logger.info(`Put Object Successful: ${successResponse.statusText}`);
    if (mirrorOperation) {
      await prepareMirrorRequests(
        reqCtx,
        req,
        bucketConfig,
        "putObject",
      );
    }
  }

  return convertSwiftPutObjectToS3Response(successResponse);
}

export async function getObject(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Get Object Request...");

  const { bucket, objectKey: object, queryParams } = s3Utils.extractRequestInfo(
    req,
  );
  if (!bucket) {
    return createOk(InvalidRequestException(
      "Bucket information missing from the request",
    ));
  }

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;

  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}/${object}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "GET",
      headers: headers,
      body: getBodyFromReq(req),
    });
  };

  let response = await retryWithExponentialBackoff(
    fetchFunc,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (!isOk(response) && bucketConfig.hasReplicas()) {
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

  return convertSwiftGetObjectToS3Response(successResponse, queryParams);
}

export async function deleteObject(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Delete Object Request...");

  const { bucket, objectKey: object } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createOk(InvalidRequestException(
      "Bucket information missing from the request",
    ));
  }

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;
  const mirrorOperation = bucketConfig.hasReplicas();

  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}/${object}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "DELETE",
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
      `Delete Object Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 204 && successResponse.status !== 404) {
    const errMessage = `Delete Object Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
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

  return convertSwiftDeleteObjectToS3Response(successResponse);
}

export async function listObjects(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Get List of Objects Request...");

  const { bucket, queryParams: query } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createOk(InvalidRequestException(
      "Bucket information missing from the request",
    ));
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);

  const params = new URLSearchParams();
  if (query.prefix) params.append("prefix", query.prefix[0]);
  if (query.delimiter) params.append("delimiter", query.delimiter[0]);
  if (query["continuation-token"]) {
    params.append("marker", query["continuation-token"][0]);
  }
  if (query["max-keys"]) params.append("limit", query["max-keys"][0]);

  headers.delete("Accept");
  headers.set("Accept", "application/json");

  const reqUrl = `${swiftUrl}/${bucket}?${params.toString()}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "GET",
      headers: headers,
      body: getBodyFromReq(req),
    });
  };

  let response = await retryWithExponentialBackoff(
    fetchFunc,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (!isOk(response) && bucketConfig.hasReplicas()) {
    logger.warn(
      `List Objects Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(
          `Get List of Objects Failed on Replica: ${replica.name}`,
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
      `Get List of Objects Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status === 404) {
    logger.warn(`Get List of Objects Failed: ${successResponse.statusText}`);
    return createOk(NoSuchBucketException());
  } else {
    logger.info(
      `Get List of Objects Successful: ${successResponse.statusText}`,
    );
  }

  const delimiter = query.delimiter ? query.delimiter[0] : null;
  const prefix = query.prefix ? query.prefix[0] : null;
  const maxKeys = query["max-keys"] ? Number(query["max-keys"][0]) : null;
  const continuationToken = query["continuation-token"]
    ? query["continuation-token"][0]
    : null;
  const formattedResponse = await toS3XmlContent(
    successResponse,
    bucket,
    delimiter,
    prefix,
    maxKeys ?? 1000,
    continuationToken,
  );

  return formattedResponse;
}

export async function getObjectMeta(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Get Object Meta Request...");

  const { bucket, objectKey: object } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    logger.error(`Bucket information missing from request`);
    return createOk(getAPIErrorResponse(APIErrors.ErrInvalidRequest));
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}/${object}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "GET",
      headers: headers,
      body: getBodyFromReq(req),
    });
  };

  let response = await retryWithExponentialBackoff(
    fetchFunc,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (!isOk(response) && bucketConfig.hasReplicas()) {
    logger.warn(
      `Get Object Meta Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(`Get bucket ACL Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
      break;
    }
  }

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Get Object Meta Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 201) {
    const errMessage = `Get Object Meta Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Get Object Meta Successful: ${successResponse.statusText}`);
  }

  return response;
}

export async function headObject(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Head Object Request...");

  const { bucket, objectKey } = s3Utils.extractRequestInfo(req);
  if (!bucket || !objectKey) {
    return createOk(InvalidRequestException(
      "Bucket information missing from the request",
    ));
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const reqUrl = `${swiftUrl}/${bucket}/${objectKey}`;

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
      `Head Object Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(`Head object Failed on Replica: ${replica.name}`);
        continue;
      }
      response = res;
      break;
    }
  }

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Head object Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  logger.info(`Head object Successful: ${successResponse.statusText}`);
  if (successResponse.status >= 300) {
    return createOk(
      new Response(null, {
        status: successResponse.status,
        headers: successResponse.headers,
      }),
    );
  }

  return convertSwiftHeadObjectToS3Response(successResponse);
}

// currently supports copy within the same project
export async function copyObject(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Copy Object Request...");
  const { bucket, objectKey: object } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createOk(InvalidRequestException(
      "Bucket information missing from the request",
    ));
  }

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;
  const mirrorOperation = bucketConfig.hasReplicas();

  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  const copySource = req.headers.get(S3_COPY_SOURCE_HEADER);
  if (!copySource) {
    return createOk(InvalidRequestException(
      `${S3_COPY_SOURCE_HEADER} missing from request`,
    ));
  }
  headers.set("X-Copy-From", copySource);
  const reqUrl = `${swiftUrl}/${bucket}/${object}`;

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
      `Copy Object Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 201) {
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

  return convertSwiftCopyObjectToS3Response(successResponse);
}

export async function createMultipartUpload(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Create Multipart Upload Request...");

  const uploadId = getRandomUUID();
  const { bucket, objectKey: object } = s3Utils.extractRequestInfo(req);
  if (!bucket || !object) {
    return createOk(InvalidRequestException(
      "Bucket information missing from the request",
    ));
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);
  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);

  // Define the path for the multipart upload session file
  const multipartSessionPath = `${MULTIPART_UPLOADS_PATH}/${uploadId}.json`;
  const multipartSessionUrl = `${swiftUrl}/${bucket}/${multipartSessionPath}`;

  // Create new upload metadata (same schema as before)
  const now = new Date().toISOString();
  const newUploadMetadata = {
    uploadId,
    bucket,
    objectKey: object,
    initiated: now,
    initiator: {
      ID: "initiator-id",
      DisplayName: "initiator",
    },
    owner: {
      ID: "owner-id",
      DisplayName: "owner",
    },
    storageClass: "STANDARD",
  };

  // Write the new upload session to its own file
  const putSessionFunc = async () => {
    return await fetch(multipartSessionUrl, {
      method: "PUT",
      headers: headers,
      body: JSON.stringify(newUploadMetadata),
    });
  };

  const putResponse = await retryWithExponentialBackoff(putSessionFunc);

  if (!isOk(putResponse)) {
    const errRes = unwrapErr(putResponse);
    const errMessage =
      `Failed to save multipart upload session: ${errRes.message}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);

    const xmlError =
      `<?xml version="1.0" encoding="UTF-8"?>\n<Error>\n  <Code>InternalError</Code>\n  <Message>Failed to save multipart upload metadata</Message>\n  <RequestId>dummy-request-id</RequestId>\n  <HostId>dummy-host-id</HostId>\n</Error>`;

    return createOk(
      new Response(xmlError, {
        status: 500,
        headers: {
          "Content-Type": "application/xml",
          "x-amz-request-id": "dummy-request-id",
          "x-amz-id-2": "dummy-host-id",
        },
      }),
    );
  }

  const successResponse = unwrapOk(putResponse);
  if (!successResponse.ok) {
    const errMessage =
      `Failed to save multipart upload session: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);

    const xmlError =
      `<?xml version="1.0" encoding="UTF-8"?>\n<Error>\n  <Code>InternalError</Code>\n  <Message>Failed to save multipart upload metadata</Message>\n  <RequestId>dummy-request-id</RequestId>\n  <HostId>dummy-host-id</HostId>\n</Error>`;

    return createOk(
      new Response(xmlError, {
        status: 500,
        headers: {
          "Content-Type": "application/xml",
          "x-amz-request-id": "dummy-request-id",
          "x-amz-id-2": "dummy-host-id",
        },
      }),
    );
  }

  logger.info(
    `Create Multipart Upload Successful: Created session at ${multipartSessionPath}`,
  );

  // Generate S3-compatible response
  const xmlResponseBody =
    `<?xml version="1.0" encoding="UTF-8"?>\n<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n  <Bucket>${bucket}</Bucket>\n  <Key>${object}</Key>\n  <UploadId>${uploadId}</UploadId>\n</InitiateMultipartUploadResult>`
      .trim();

  const requestId = getRandomUUID();
  const hostId = getRandomUUID();

  const responseHeaders = new Headers({
    "Content-Type": "application/xml",
    "x-amz-request-id": requestId,
    "x-amz-id-2": hostId,
  });

  return createOk(
    new Response(xmlResponseBody, {
      status: 200,
      headers: responseHeaders,
    }),
  );
}

// https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html#API_CreateMultipartUpload_ResponseSyntax
function generateCompleteMultipartUploadResponse(
  bucketName: string,
  objectKey: string,
  location: string,
  eTag: string,
): Result<Response, Error> {
  const quotedETag = `"${eTag}"`;

  const xmlResponseBody = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>${location}</Location>
  <Bucket>${bucketName}</Bucket>
  <Key>${objectKey}</Key>
  <ETag>${quotedETag}</ETag>
</CompleteMultipartUploadResult>`.trim();

  const headers = new Headers({
    "Content-Type": "application/xml",
    "ETag": quotedETag, // REQUIRED
    "x-amz-request-id": "dummy-request-id", // Recommended
    "x-amz-id-2": "dummy-host-id", // Recommended
  });

  return createOk(
    new Response(xmlResponseBody, {
      status: 200,
      headers,
    }),
  );
}

export async function completeMultipartUpload(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Complete Multipart Upload Request...");
  const { bucket, objectKey: object } = s3Utils.extractRequestInfo(req);
  if (!bucket || !object) {
    return createOk(InvalidRequestException(
      "Bucket information missing from the request",
    ));
  }

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;
  const mirrorOperation = bucketConfig.hasReplicas();

  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);
  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);
  headers.append("X-Object-Manifest", `${bucket}/${object}`);

  const reqUrl = `${swiftUrl}/${bucket}/${object}`;

  // Get the uploadId from query parameters
  const { queryParams } = s3Utils.extractRequestInfo(req);
  const uploadId = queryParams["uploadId"]?.[0];
  if (!uploadId) {
    return createOk(MissingUploadIdException());
  }

  // Fetch the existing index file to remove the upload metadata
  try {
    const fetchIndexFunc = async () => {
      return await fetch(reqUrl, {
        method: "GET",
        headers: headers,
      });
    };
    const indexResponse = await retryWithExponentialBackoff(fetchIndexFunc);

    if (isOk(indexResponse) && unwrapOk(indexResponse).ok) {
      const successResponse = unwrapOk(indexResponse);
      const indexData = await successResponse.json();
      // Filter out the completed upload
      const updatedUploads = indexData.uploads.filter((
        upload: { uploadId: string },
      ) => upload.uploadId !== uploadId);

      // Update the index file
      const updateIndexFunc = async () => {
        return await fetch(reqUrl, {
          method: "PUT",
          headers: headers,
          body: JSON.stringify(updatedUploads),
        });
      };
      await retryWithExponentialBackoff(updateIndexFunc);
      logger.info(`Removed upload ${uploadId} from multipart uploads index`);
    } else {
      logger.warn(
        `Failed to fetch multipart uploads index: ${
          !isOk(indexResponse)
            ? unwrapErr(indexResponse).message
            : unwrapOk(indexResponse).statusText
        }`,
      );
    }
  } catch (error) {
    logger.warn(
      `Error updating multipart uploads index: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return createOk(InternalServerErrorException());
  }

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "PUT",
      headers: headers,
    });
  };
  const response = await retryWithExponentialBackoff(
    fetchFunc,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Complete Multipart Upload Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 201) {
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

  const etag = successResponse.headers.get("eTag");
  if (!etag) {
    return createOk(InvalidRequestException("ETag not found in response"));
  }

  const result = generateCompleteMultipartUploadResponse(
    bucket,
    object,
    config.region,
    etag,
  );

  return result;
}

export async function uploadPart(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Upload Part Request...");
  const { bucket, objectKey: object, queryParams } = s3Utils.extractRequestInfo(
    req,
  );
  if (!bucket) {
    return createOk(InvalidRequestException(
      "Bucket information missing from the request",
    ));
  }

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);
  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);

  const partNumber = queryParams["partNumber"];
  if (!partNumber) {
    return createOk(InvalidRequestException(
      "Bad Request: partNumber is missing from request",
    ));
  }

  const reqUrl = `${swiftUrl}/${bucket}/${object}/${partNumber}`;
  const bodyBuffer = await getBodyBuffer(req);
  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "PUT",
      headers: headers,
      body: bodyBuffer,
    });
  };
  const response = await retryWithExponentialBackoff(
    fetchFunc,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `Upload Part Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 201) {
    const errMessage = `Upload Part Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(`Upload Part Successful: ${successResponse.statusText}`);
  }

  return convertSwiftUploadPartToS3Response(successResponse, logger);
}

export function uploadPartCopy(
  _reqCtx: RequestContext,
  _req: Request,
  _bucketConfig: Bucket,
): Result<Response, Error> {
  return createOk(NotImplementedException());
}

export async function listParts(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying ListParts Request...");

  const { bucket, queryParams: query, objectKey } = s3Utils.extractRequestInfo(
    req,
  );

  if (!bucket) {
    return createOk(InvalidRequestException(
      "Bucket information missing from the request",
    ));
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);

  const params = new URLSearchParams();
  if (query.prefix) params.append("prefix", query.prefix[0]);
  if (query.delimiter) params.append("delimiter", "/");
  if (query["part-number-marker"]) {
    params.append("marker", query["part-number-marker"][0]);
  }
  if (query["max-parts"]) params.append("limit", query["max-parts"][0]);

  headers.delete("Accept");
  headers.set("Accept", "application/json");

  // FIXME: cant append objectKey directly, swift doesn't allow to access the parts just like files in folders, needs to be fetched selectively
  const reqUrl = `${swiftUrl}/${bucket}?${params.toString()}`;

  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "GET",
      headers: headers,
    });
  };

  let response = await retryWithExponentialBackoff(
    fetchFunc,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  if (!isOk(response) && bucketConfig.hasReplicas()) {
    logger.warn(
      `ListParts Failed on Primary Bucket: ${bucketConfig.bucketName}`,
    );
    logger.warn("Trying on Replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (res instanceof Error) {
        logger.warn(
          `ListParts Failed on Replica: ${replica.name}`,
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
      `ListParts Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status === 404) {
    logger.warn(`ListParts Failed: ${successResponse.statusText}`);
    const errMessage = await successResponse.text();
    return createErr(
      new HeraldError(successResponse.status, {
        message: `${errMessage} in Swift Storage`,
      }),
    );
  } else {
    logger.info(`ListParts Successful: ${successResponse.statusText}`);
  }

  const uploadId = query["uploadId"][0] ?? null;
  const maxKeys = query["max-parts"] ? Number(query["max-parts"][0]) : null;
  const partNumberMarker = query["part-number-marker"]
    ? parseInt(query["part-number-marker"][0])
    : null;
  const formattedResponse = await toS3ListPartXmlContent(
    successResponse,
    bucket,
    objectKey,
    uploadId,
    partNumberMarker,
    maxKeys ?? null,
  );
  return formattedResponse;
}

export async function abortMultipartUpload(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying AbortMultipartUpload Request...");

  const { bucket, objectKey: object } = s3Utils.extractRequestInfo(req);
  const url = new URL(req.url);
  const uploadId = url.searchParams.get("uploadId");

  if (!bucket || !object || !uploadId) {
    return createOk(InvalidRequestException(
      "Bucket, object, or uploadId information missing from the request",
    ));
  }

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);

  // First, update the multipart uploads index to remove this upload
  const multipartIndexPath = `${MULTIPART_UPLOADS_PATH}/index.json`;
  const multipartIndexUrl = `${swiftUrl}/${bucket}/${multipartIndexPath}`;

  // Try to fetch the existing index file
  let existingUploads = [];
  try {
    const fetchIndexFunc = async () => {
      return await fetch(multipartIndexUrl, {
        method: "GET",
        headers: headers,
      });
    };

    const indexResponse = await retryWithExponentialBackoff(fetchIndexFunc);

    if (!isOk(indexResponse)) {
      const errRes = unwrapErr(indexResponse);
      logger.warn(`Failed to fetch multipart index: ${errRes.message}`);
    } else {
      const successResponse = unwrapOk(indexResponse);
      const indexData = await successResponse.json();
      existingUploads = Array.isArray(indexData.uploads)
        ? indexData.uploads
        : [];

      // Filter out the upload being aborted
      existingUploads = existingUploads.filter((upload: { uploadId: string }) =>
        upload.uploadId !== uploadId
      );

      // Update the index file
      const now = new Date().toISOString();
      const updatedIndex = {
        lastUpdated: now,
        uploads: existingUploads,
      };

      const updateIndexFunc = async () => {
        return await fetch(multipartIndexUrl, {
          method: "PUT",
          headers: headers,
          body: JSON.stringify(updatedIndex),
        });
      };

      const updateResponse = await retryWithExponentialBackoff(updateIndexFunc);

      if (!isOk(updateResponse) || !unwrapOk(updateResponse).ok) {
        const errMessage = !isOk(updateResponse)
          ? `Failed to update multipart uploads index: ${
            unwrapErr(updateResponse).message
          }`
          : `Failed to update multipart uploads index: ${
            unwrapOk(updateResponse).statusText
          }`;
        logger.warn(errMessage);
        reportToSentry(errMessage);
      } else {
        logger.info(
          `Successfully removed upload ${uploadId} from index at ${multipartIndexPath}`,
        );
      }
    }
  } catch (error) {
    logger.warn(
      `Error updating multipart uploads index: ${(error as Error).message}`,
    );
    reportToSentry(
      `Error updating multipart uploads index: ${(error as Error).message}`,
    );
    return createOk(InternalServerErrorException());
  }

  // Now delete the object parts
  const reqUrl = `${swiftUrl}/${bucket}/${object}`;
  const fetchFunc = async () => {
    return await fetch(reqUrl, {
      method: "DELETE",
      headers: headers,
    });
  };

  const response = await retryWithExponentialBackoff(fetchFunc);

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    logger.warn(
      `AbortMultipartUpload Failed. Failed to connect with Object Storage: ${errRes.message}`,
    );
    return response;
  }

  const successResponse = unwrapOk(response);
  if (successResponse.status !== 204) {
    const errMessage =
      `AbortMultipartUpload Failed: ${successResponse.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
  } else {
    logger.info(
      `AbortMultipartUpload Successful: ${successResponse.statusText}`,
    );
  }

  // Return a successful response according to S3 spec
  const responseHeaders = new Headers({
    "x-amz-request-id": getRandomUUID(),
    "x-amz-id-2": getRandomUUID(),
  });

  return createOk(
    new Response(null, {
      status: 204,
      headers: responseHeaders,
    }),
  );
}

export async function listMultipartUploads(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying List Multipart Uploads Request...");

  const { bucket, queryParams: query } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createOk(InvalidRequestException(
      "Bucket information missing from the request",
    ));
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);

  // Define the path for the multipart uploads index file
  const multipartIndexPath = `${MULTIPART_UPLOADS_PATH}/index.json`;
  const multipartIndexUrl = `${swiftUrl}/${bucket}/${multipartIndexPath}`;

  // Fetch the multipart uploads index file
  const fetchIndexFunc = async () => {
    return await fetch(multipartIndexUrl, {
      method: "GET",
      headers: headers,
    });
  };

  const indexResponse = await retryWithExponentialBackoff(
    fetchIndexFunc,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );

  // Fixme: proper response not being propagated
  if (!isOk(indexResponse) && bucketConfig.hasReplicas()) {
    logger.warn("List Multipart Uploads Failed on Primary. Trying replicas...");
    for (const replica of bucketConfig.replicas) {
      const res = replica.typ === "ReplicaS3Config"
        ? await s3Resolver(reqCtx, req, replica)
        : await swiftResolver(reqCtx, req, replica);
      if (!(res instanceof Error)) {
        return res; // Return the successful response from replica
      }
    }
    return indexResponse; // Return the original error if all replicas failed
  }

  if (!isOk(indexResponse) || unwrapOk(indexResponse).status === 404) {
    logger.error("List Multipart Uploads Failed: ", indexResponse);
    return createOk(InternalServerErrorException());
  }

  // Parse the index file
  let uploads = [];
  try {
    const indexData = await unwrapOk(indexResponse).json();
    uploads = Array.isArray(indexData.uploads) ? indexData.uploads : [];
  } catch (error) {
    logger.warn(
      `Error parsing multipart uploads index: ${(error as Error).message}`,
    );
    return createOk(InternalServerErrorException());
  }

  // Extract query parameters
  const prefix = query.prefix ? query.prefix[0] : "";
  const delimiter = query.delimiter ? query.delimiter[0] : "";
  const keyMarker = query["key-marker"] ? query["key-marker"][0] : "";
  const uploadIdMarker = query["upload-id-marker"]
    ? query["upload-id-marker"][0]
    : "";
  const maxUploads = query["max-uploads"]
    ? parseInt(query["max-uploads"][0], 10)
    : 1000;

  // Apply filtering based on the parameters
  let filteredUploads = uploads;

  // Filter by prefix if provided
  if (prefix) {
    filteredUploads = filteredUploads.filter((upload: { objectKey: string }) =>
      upload.objectKey && upload.objectKey.startsWith(prefix)
    );
  }

  // Filter by key-marker if provided
  if (keyMarker) {
    filteredUploads = filteredUploads.filter((
      upload: { objectKey: string | number; uploadId: string },
    ) =>
      upload.objectKey > keyMarker ||
      (upload.objectKey === keyMarker && upload.uploadId > uploadIdMarker)
    );
  }

  // Sort uploads by objectKey and uploadId
  filteredUploads.sort(
    (
      a: { objectKey: number; uploadId: string },
      b: { objectKey: number; uploadId: string },
    ) => {
      if (a.objectKey < b.objectKey) return -1;
      if (a.objectKey > b.objectKey) return 1;
      return a.uploadId.localeCompare(b.uploadId);
    },
  );

  // Handle common prefixes if delimiter is provided
  const commonPrefixes = new Set<string>();
  if (delimiter) {
    filteredUploads = filteredUploads.filter(
      (upload: { objectKey: string }) => {
        if (!upload.objectKey.startsWith(prefix)) return false;

        const restKey = upload.objectKey.substring(prefix.length);
        const delimiterIndex = restKey.indexOf(delimiter);

        if (delimiterIndex >= 0) {
          const commonPrefix = prefix +
            restKey.substring(0, delimiterIndex + delimiter.length);
          commonPrefixes.add(commonPrefix);
          return false;
        }
        return true;
      },
    );
  }

  // Apply limit
  const isTruncated = filteredUploads.length > maxUploads;
  filteredUploads = filteredUploads.slice(0, maxUploads);

  // Determine next markers
  const nextKeyMarker = isTruncated && filteredUploads.length > 0
    ? filteredUploads[filteredUploads.length - 1].objectKey
    : "";
  const nextUploadIdMarker = isTruncated && filteredUploads.length > 0
    ? filteredUploads[filteredUploads.length - 1].uploadId
    : "";

  // Format uploads for XML response
  const formattedUploads = filteredUploads.map((
    upload: {
      objectKey: string;
      uploadId: string;
      initiated: string;
      initiator: string;
      owner: string;
      storageClass: string;
    },
  ) => ({
    Key: upload.objectKey,
    UploadId: upload.uploadId,
    Initiated: upload.initiated,
    Initiator: upload.initiator || {
      ID: "initiator-id",
      DisplayName: "initiator",
    },
    Owner: upload.owner || {
      ID: "owner-id",
      DisplayName: "owner",
    },
    StorageClass: upload.storageClass || "STANDARD",
  }));

  // Build XML response
  const xmlResponse = {
    ListMultipartUploadsResult: {
      Bucket: bucket,
      KeyMarker: keyMarker,
      UploadIdMarker: uploadIdMarker,
      NextKeyMarker: nextKeyMarker,
      NextUploadIdMarker: nextUploadIdMarker,
      Prefix: prefix,
      Delimiter: delimiter,
      MaxUploads: maxUploads,
      IsTruncated: isTruncated,
      Upload: formattedUploads,
      CommonPrefixes: Array.from(commonPrefixes).map((prefix) => ({
        Prefix: prefix,
      })),
    },
  };

  const xmlBuilder = new xml2js.Builder();
  const formattedXml = xmlBuilder.buildObject(xmlResponse);

  return createOk(
    new Response(formattedXml, {
      headers: {
        "Content-Type": "application/xml",
        "x-amz-request-id": getRandomUUID(),
        "x-amz-id-2": getRandomUUID(),
      },
    }),
  );
}
