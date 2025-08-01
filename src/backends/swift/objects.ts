import * as xml2js from "xml2js";

import { reportToSentry } from "../../utils/log.ts";
import { HeraldError } from "../../types/http-exception.ts";
import { getSwiftRequestHeaders } from "./auth.ts";
import {
  getBodyBuffer,
  getBodyFromReq,
  retryWithExponentialBackoff,
} from "../../utils/url.ts";
import {
  toS3ListPartXmlContent,
  toS3XmlContent,
  toSwiftBulkDeleteBody,
} from "./utils/mod.ts";
import {
  InternalServerErrorException,
  InvalidRequestException,
  MalformedXMLException,
  MissingUploadIdException,
  NoSuchBucketException,
  NoSuchUploadException,
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
import { Logger } from "std/log";

// Utility: Send raw HTTP POST using Deno.connect (manual HTTP)
async function sendManualBulkDeleteRequest(
  host: string,
  path: string,
  token: string,
  body: string,
  accept = "application/json",
) {
  const port = 443;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // Ensure trailing newline
  if (!body.endsWith("\n")) body += "\n";
  const contentLength = encoder.encode(body).length;
  const request = [
    `POST ${path} HTTP/1.1`,
    `Host: ${host}`,
    `X-Auth-Token: ${token}`,
    `Content-Type: text/plain`,
    `Accept: ${accept}`,
    `Content-Length: ${contentLength}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");

  const conn = await Deno.connectTls({ hostname: host, port });
  await conn.write(encoder.encode(request));
  let response = "";
  const buf = new Uint8Array(4096);
  while (true) {
    const n = await conn.read(buf);
    if (n === null) break;
    response += decoder.decode(buf.subarray(0, n));
  }
  conn.close();
  // Return as a Response object for consistency
  return response;
}

function getBulkDeleteJsonBody(
  raw: string,
  logger: Logger,
) {
  const [_headerPart, ...bodyParts] = raw.split("\r\n\r\n");
  let body = bodyParts.join("\r\n\r\n").trim();

  if (/^[0-9A-Fa-f]+\r?\n/.test(body)) {
    // Remove chunk size lines
    body = body.replace(/^[0-9A-Fa-f]+\r?\n/mg, "");
    body = body.replace(/\r?\n0\r?\n?$/, ""); // Remove ending 0
    body = body.trim();
  }

  // deno-lint-ignore no-explicit-any
  let json: any = {};
  try {
    json = JSON.parse(body);
  } catch {
    logger.warn("Failed parsing bulk delete json body");
  }

  return json;
}

/**
 * Converts a raw HTTP response string from Swift bulk delete
 * into an S3-compatible DeleteObjects XML response.
 */
function convertManualBulkDeleteToS3Response(
  raw: string,
  deletedKeys: string[],
): Result<Response, Error> {
  // 1. Parse the HTTP response string
  const [headerPart, ...bodyParts] = raw.split("\r\n\r\n");
  let body = bodyParts.join("\r\n\r\n").trim();

  // Extract status code from the first line of the header
  let status = 200;
  const statusLine = headerPart.split("\r\n")[0];
  const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
  if (statusMatch) {
    status = parseInt(statusMatch[1], 10);
  }

  // Handle chunked encoding (remove chunk size lines)
  if (/^[0-9A-Fa-f]+\r?\n/.test(body)) {
    // Remove chunk size lines
    body = body.replace(/^[0-9A-Fa-f]+\r?\n/mg, "");
    body = body.replace(/\r?\n0\r?\n?$/, ""); // Remove ending 0
    body = body.trim();
  }

  // deno-lint-ignore no-explicit-any
  let json: any = {};
  try {
    json = JSON.parse(body);
  } catch {
    return createErr(
      new Error(
        "Failed to parse JSON response from Swift bulk delete",
      ),
    );
  }

  // 3. Build S3 DeleteResult XML
  const deleted = [];
  for (let i = 0; i < (json["Number Deleted"] || 0); i++) {
    // Use deletedKeys if available, else just <Deleted/>
    deleted.push(`<Deleted><Key>${deletedKeys[i] || ""}</Key></Deleted>`);
  }
  const errors = (json.Errors || []).map((err: Record<string, unknown>) =>
    `<Error><Key>${err["Key"] || ""}</Key><Code>${
      err["Code"] || "Error"
    }</Code><Message>${err["Message"] || ""}</Message></Error>`
  );

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n  ${
      deleted.join("\n  ")
    }\n  ${errors.join("\n  ")}\n</DeleteResult>`;

  // 4. Return as a Response, using the parsed status code
  return createOk(
    new Response(xml, {
      status,
      headers: { "Content-Type": "application/xml" },
    }),
  );
}

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
  // Forward Range header if present
  const rangeHeader = req.headers.get("range") || req.headers.get("Range");
  if (rangeHeader) {
    headers.set("Range", rangeHeader);
  }
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
  if (successResponse.status !== 200 && successResponse.status !== 206) {
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

export async function deleteObjects(
  reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  const logger = reqCtx.logger;
  logger.info("[Swift backend] Proxying Delete Object Request...");

  const { bucket } = s3Utils.extractRequestInfo(req);
  if (!bucket) {
    return createOk(InvalidRequestException(
      "Bucket information missing from the request",
    ));
  }

  const config: SwiftConfig = bucketConfig.config as SwiftConfig;
  const mirrorOperation = bucketConfig.hasReplicas();

  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const url = new URL(swiftUrl);
  const host = url.hostname;
  // Path should be /v1/ACCOUNT?bulk-delete
  const path = url.pathname + "?bulk-delete";

  const requestBody = await toSwiftBulkDeleteBody(req, bucket);
  if (!isOk(requestBody)) {
    const errMessage = unwrapErr(requestBody);
    logger.warn(
      `Error reading request body for bulk delete: ${errMessage.message}`,
    );
    return requestBody;
  }
  const bulkDeleteObjects = unwrapOk(requestBody);
  // If USE_MANUAL_HTTP env var is set, use manual HTTP
  logger.info("Using manual HTTP bulk delete via Deno.connect...");
  const fetchFunc = async () => {
    return await sendManualBulkDeleteRequest(
      host,
      path,
      authToken,
      bulkDeleteObjects,
      "application/json",
    );
  };
  const response = await retryWithExponentialBackoff(
    fetchFunc,
    bucketConfig.hasReplicas() || bucketConfig.isReplica ? 1 : 3,
  );
  logger.info("Manual HTTP response:\n" + Deno.inspect(response));

  if (!isOk(response)) {
    const errMsg = `Error in manual HTTP bulk delete: ${
      unwrapErr(response).message
    }`;
    logger.error(errMsg);
    reportToSentry(errMsg);
    return response;
  }

  const successResponse = unwrapOk(response);
  // Parse the keys that were requested for deletion
  const keys = bulkDeleteObjects.split("\n").filter(Boolean);

  const convertedResponse = convertManualBulkDeleteToS3Response(
    successResponse,
    keys,
  );

  if (!isOk(convertedResponse)) {
    const errMsg = `Error converting manual HTTP response: ${
      unwrapErr(convertedResponse).message
    }`;
    logger.error(errMsg);
    reportToSentry(errMsg);
  } else if (mirrorOperation && unwrapOk(convertedResponse).status === 200) {
    // TODO(needs thinking): operation failure and success is not for the whole objects, needs to be handled for each object seprately since one may fail and others may succeed
    await prepareMirrorRequests(
      reqCtx,
      req,
      bucketConfig,
      "deleteObjects",
    );
  }

  return convertedResponse;
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

interface MPUPart {
  partNumber: string;
  size: number;
  etag: string;
  eTag: string;
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

  // --- SLO Implementation ---
  // Get the uploadId from query parameters
  const { queryParams } = s3Utils.extractRequestInfo(req);
  const uploadId = queryParams["uploadId"]?.[0];
  if (!uploadId) {
    return createOk(MissingUploadIdException());
  }

  // Define the path for the multipart upload session file
  const multipartSessionPath = `${MULTIPART_UPLOADS_PATH}/${uploadId}.json`;
  const multipartSessionUrl = `${swiftUrl}/${bucket}/${multipartSessionPath}`;

  // Fetch the session file to get the parts array
  let sessionJson;
  try {
    const getSessionFunc = async () => {
      return await fetch(multipartSessionUrl, {
        method: "GET",
        headers: headers,
      });
    };
    const getSessionResponse = await retryWithExponentialBackoff(
      getSessionFunc,
    );
    if (
      !isOk(getSessionResponse) || unwrapOk(getSessionResponse).status === 404
    ) {
      logger.error(
        `Multipart upload session file not found for uploadId ${uploadId} at ${multipartSessionPath}`,
      );
      // complete multipart upload can be called again so just return
      // Check if the manifest object exists (idempotency)
      const manifestUrl = `${swiftUrl}/${bucket}/${object}`;
      const manifestResp = await fetch(manifestUrl, {
        method: "HEAD",
        headers,
      });
      if (manifestResp.ok) {
        const etag = manifestResp.headers.get("etag") ||
          manifestResp.headers.get("ETag") || "";
        return generateCompleteMultipartUploadResponse(
          bucket,
          object,
          config.region,
          etag,
        );
      } else {
        // Manifest does not exist, return error
        return createOk(MissingUploadIdException());
      }
    }
    sessionJson = await unwrapOk(getSessionResponse).json();
  } catch (error) {
    logger.error(
      `Error reading multipart upload session file for uploadId ${uploadId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return createOk(MissingUploadIdException());
  }

  // Build the SLO manifest from the parts array
  const parts = Array.isArray(sessionJson.parts) ? sessionJson.parts : [];
  if (parts.length === 0) {
    logger.error(`No parts found in session file for uploadId ${uploadId}`);
    return createOk(
      MalformedXMLException(),
    );
  }
  // Sort parts by partNumber (as string, but should be numeric order)
  parts.sort((a: MPUPart, b: MPUPart) =>
    Number(a.partNumber) - Number(b.partNumber)
  );
  const manifest = parts.map((
    part: MPUPart,
  ) => ({
    path: `/${bucket}/${object}/${part.partNumber}`,
    etag: (part.eTag || part.etag || "").replace(/\"/g, ""),
    size_bytes: part.size,
  }));

  // PUT the SLO manifest
  const manifestUrl = `${swiftUrl}/${bucket}/${object}?multipart-manifest=put`;
  const sloHeaders = getSwiftRequestHeaders(authToken);
  sloHeaders.set("Content-Type", "application/json");
  const putManifestFunc = async () => {
    return await fetch(manifestUrl, {
      method: "PUT",
      headers: sloHeaders,
      body: JSON.stringify(manifest),
    });
  };
  const putManifestResponse = await retryWithExponentialBackoff(
    putManifestFunc,
  );
  if (!isOk(putManifestResponse)) {
    const errRes = unwrapErr(putManifestResponse);
    logger.warn(
      `Complete Multipart Upload Failed. Failed to PUT SLO manifest: ${errRes.message}`,
    );
    return putManifestResponse;
  }
  const manifestSuccess = unwrapOk(putManifestResponse);
  if (manifestSuccess.status !== 201 && manifestSuccess.status !== 200) {
    const errMessage =
      `Complete Multipart Upload Failed: ${manifestSuccess.statusText}`;
    logger.warn(errMessage);
    reportToSentry(errMessage);
    return createOk(InvalidRequestException(errMessage));
  }

  // Delete the per-upload JSON file
  try {
    const deleteSessionFunc = async () => {
      return await fetch(multipartSessionUrl, {
        method: "DELETE",
        headers: headers,
      });
    };
    const deleteResponse = await retryWithExponentialBackoff(deleteSessionFunc);
    if (!isOk(deleteResponse) || unwrapOk(deleteResponse).status === 404) {
      logger.error(
        `Multipart upload session file not found for uploadId ${uploadId} at ${multipartSessionPath}`,
      );
      // Continue to next step
    } else if (!unwrapOk(deleteResponse).ok) {
      logger.warn(
        `Failed to delete multipart upload session file for uploadId ${uploadId}: ${
          unwrapOk(deleteResponse).statusText
        }`,
      );
      // Continue to next step
    } else {
      logger.info(
        `Deleted multipart upload session file for uploadId ${uploadId}`,
      );
    }
  } catch (error) {
    logger.error(
      `Error deleting multipart upload session file for uploadId ${uploadId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // Continue to next step
  }

  // NOTE: deleting the parts right away is not possible since Swift takes time to assemble the segments.
  // // Bulk-delete the part objects
  // const prefix = `${object}/`;
  // const listParams = new URLSearchParams();
  // listParams.append("prefix", prefix);
  // listParams.append("format", "json");
  // const listUrl = `${swiftUrl}/${bucket}?${listParams.toString()}`;
  // const listFunc = async () => {
  //   return await fetch(listUrl, {
  //     method: "GET",
  //     headers: headers,
  //   });
  // };
  // const listResponse = await retryWithExponentialBackoff(listFunc);
  // if (isOk(listResponse) && unwrapOk(listResponse).ok) {
  //   const objectsJson = await unwrapOk(listResponse).json();
  //   const objectsToDelete = (objectsJson || [])
  //     .filter((item: { name: string }) =>
  //       item.name && item.name.startsWith(prefix)
  //     )
  //     .map((item: { name: string }) => `${bucket}/${item.name}`);
  //   if (objectsToDelete.length > 0) {
  //     const urlObj = new URL(swiftUrl);
  //     const host = urlObj.hostname;
  //     const path = urlObj.pathname + "?bulk-delete";
  //     const bulkDeleteBody = objectsToDelete.join("\n");
  //     const bulkDeleteFunc = async () => {
  //       return await sendManualBulkDeleteRequest(
  //         host,
  //         path,
  //         authToken,
  //         bulkDeleteBody,
  //         "application/json",
  //       );
  //     };
  //     await retryWithExponentialBackoff(bulkDeleteFunc);
  //   }
  // }

  // SLO ETag is the MD5 of the concatenated ETags of the segments, in quotes
  // For now, just return the ETag from the manifest response if available
  const sloEtag = manifestSuccess.headers.get("etag") ||
    manifestSuccess.headers.get("ETag") || "";

  const result = generateCompleteMultipartUploadResponse(
    bucket,
    object,
    config.region,
    sloEtag,
  );

  logger.info(`Complete MultipartUpload Successful`);
  if (mirrorOperation) {
    await prepareMirrorRequests(
      reqCtx,
      req,
      bucketConfig,
      "completeMultipartUpload",
    );
  }

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
  const uploadId = queryParams["uploadId"]?.[0];
  if (!partNumber) {
    return createOk(InvalidRequestException(
      "Bad Request: partNumber is missing from request",
    ));
  }
  if (!uploadId) {
    return createOk(InvalidRequestException(
      "Bad Request: uploadId is missing from request",
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
    const multipartSessionPath = `${MULTIPART_UPLOADS_PATH}/${uploadId}.json`;
    const multipartSessionUrl = `${swiftUrl}/${bucket}/${multipartSessionPath}`;
    try {
      // Fetch the current session JSON
      const getSessionFunc = async () => {
        return await fetch(multipartSessionUrl, {
          method: "GET",
          headers: headers,
        });
      };
      const getSessionResponse = await retryWithExponentialBackoff(
        getSessionFunc,
      );
      if (
        !isOk(getSessionResponse) || unwrapOk(getSessionResponse).status === 404
      ) {
        logger.error(
          `Multipart upload session file not found for uploadId ${uploadId} at ${multipartSessionPath}`,
        );
      } else {
        const sessionJson = await unwrapOk(getSessionResponse).json();
        // Prepare part metadata
        const eTag = successResponse.headers.get("etag") ||
          successResponse.headers.get("ETag") || "";
        const size = bodyBuffer?.byteLength || 0;
        const lastModified = new Date().toISOString();
        const partMeta = {
          partNumber: Array.isArray(partNumber) ? partNumber[0] : partNumber,
          eTag,
          size,
          lastModified,
        };
        // Update or create the parts array
        if (!Array.isArray(sessionJson.parts)) sessionJson.parts = [];
        // Remove any existing entry for this partNumber
        sessionJson.parts = sessionJson.parts.filter((
          p: { partNumber: string },
        ) => p.partNumber !== partMeta.partNumber);
        sessionJson.parts.push(partMeta);
        // Save the updated session JSON
        const putSessionFunc = async () => {
          return await fetch(multipartSessionUrl, {
            method: "PUT",
            headers: headers,
            body: JSON.stringify(sessionJson),
          });
        };
        const putSessionResponse = await retryWithExponentialBackoff(
          putSessionFunc,
        );
        if (!isOk(putSessionResponse) || !unwrapOk(putSessionResponse).ok) {
          logger.error(
            `Failed to update multipart upload session file for uploadId ${uploadId} at ${multipartSessionPath}`,
          );
        } else {
          logger.info(
            `Updated multipart upload session file for uploadId ${uploadId} with part ${partMeta.partNumber}`,
          );
        }
      }
    } catch (error) {
      logger.error(
        `Error updating multipart upload session file for uploadId ${uploadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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

  if (!bucket || !objectKey) {
    return createOk(InvalidRequestException(
      "Bucket or Object information missing from the request",
    ));
  }

  const config = bucketConfig.config as SwiftConfig;
  const res = reqCtx.heraldContext.keystoneStore.getConfigAuthMeta(config);

  const { storageUrl: swiftUrl, token: authToken } = res;
  const headers = getSwiftRequestHeaders(authToken);

  // First check if the uploadId exists by checking the session file
  const uploadId = query["uploadId"]?.[0];
  if (!uploadId) {
    return createOk(InvalidRequestException(
      "uploadId missing from the request",
    ));
  }

  const multipartSessionPath = `${MULTIPART_UPLOADS_PATH}/${uploadId}.json`;
  const multipartSessionUrl = `${swiftUrl}/${bucket}/${multipartSessionPath}`;

  // Check if the session file exists
  const sessionCheckFunc = async () => {
    return await fetch(multipartSessionUrl, {
      method: "HEAD",
      headers: headers,
    });
  };

  const sessionResponse = await retryWithExponentialBackoff(sessionCheckFunc);
  if (!isOk(sessionResponse) || unwrapOk(sessionResponse).status === 404) {
    logger.warn(
      `Multipart upload session file not found for uploadId ${uploadId} at ${multipartSessionPath}`,
    );
    return createOk(NoSuchUploadException());
  }

  const params = new URLSearchParams();
  if (query.prefix) {
    params.append("prefix", query.prefix[0]);
  } else {
    params.append("prefix", objectKey);
  }
  if (query.delimiter) params.append("delimiter", "/");
  if (query["part-number-marker"]) {
    params.append("marker", `${objectKey}/${query["part-number-marker"][0]}`);
  }
  if (query["max-parts"]) params.append("limit", query["max-parts"][0]);

  headers.delete("Accept");
  headers.set("Accept", "application/json");

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

  // Delete the per-upload JSON file (session file)
  const multipartSessionPath = `${MULTIPART_UPLOADS_PATH}/${uploadId}.json`;
  const multipartSessionUrl = `${swiftUrl}/${bucket}/${multipartSessionPath}`;
  try {
    const deleteSessionFunc = async () => {
      return await fetch(multipartSessionUrl, {
        method: "DELETE",
        headers: headers,
      });
    };
    const deleteResponse = await retryWithExponentialBackoff(deleteSessionFunc);
    if (!isOk(deleteResponse) || unwrapOk(deleteResponse).status === 404) {
      logger.error(
        `Multipart upload session file not found for uploadId ${uploadId} at ${multipartSessionPath}`,
      );
      // Continue to next step
    } else if (!unwrapOk(deleteResponse).ok) {
      logger.warn(
        `Failed to delete multipart upload session file for uploadId ${uploadId}: ${
          unwrapOk(deleteResponse).statusText
        }`,
      );
      // Continue to next step
    } else {
      logger.info(
        `Deleted multipart upload session file for uploadId ${uploadId}`,
      );
    }
  } catch (error) {
    logger.error(
      `Error deleting multipart upload session file for uploadId ${uploadId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // Continue to next step
  }

  // List all objects with the prefix for this multipart upload
  const prefix = `${object}/`;
  const listParams = new URLSearchParams();
  listParams.append("prefix", prefix);
  listParams.append("format", "json");
  const listUrl = `${swiftUrl}/${bucket}?${listParams.toString()}`;
  const listFunc = async () => {
    return await fetch(listUrl, {
      method: "GET",
      headers: headers,
    });
  };
  const listResponse = await retryWithExponentialBackoff(listFunc);
  if (!isOk(listResponse)) {
    const errRes = unwrapErr(listResponse);
    logger.error(
      `AbortMultipartUpload Failed. Could not list parts: ${errRes.message}`,
    );
    return listResponse;
  }
  const listOk = unwrapOk(listResponse);
  if (!listOk.ok) {
    logger.error(
      `AbortMultipartUpload Failed. Could not list parts: ${listOk.statusText}`,
    );
    return createErr(new Error(listOk.statusText));
  }
  const objectsJson = await listOk.json();
  const objectsToDelete = (objectsJson || [])
    .filter((item: { name: string }) =>
      item.name && item.name.startsWith(prefix)
    )
    .map((item: { name: string }) => `${bucket}/${item.name}`);

  if (objectsToDelete.length === 0) {
    logger.info(`No parts found for multipart upload with prefix ${prefix}`);
  } else {
    // Bulk delete all parts
    const urlObj = new URL(swiftUrl);
    const host = urlObj.hostname;
    const path = urlObj.pathname + "?bulk-delete";
    const bulkDeleteBody = objectsToDelete.join("\n");
    logger.info(
      `Bulk deleting ${objectsToDelete.length} parts for prefix ${prefix}`,
    );
    const bulkDeleteFunc = async () => {
      return await sendManualBulkDeleteRequest(
        host,
        path,
        authToken,
        bulkDeleteBody,
        "application/json",
      );
    };
    const bulkDeleteResponseResult = await retryWithExponentialBackoff(
      bulkDeleteFunc,
    );
    if (!isOk(bulkDeleteResponseResult)) {
      logger.error(
        `Bulk delete failed for prefix ${prefix}: ${
          unwrapErr(bulkDeleteResponseResult).message
        }`,
      );
      return bulkDeleteResponseResult;
    }

    const deleteResBody = unwrapOk(bulkDeleteResponseResult);
    const jsonBody = getBulkDeleteJsonBody(deleteResBody, logger);
    logger.info(`Bulk Delete Parts Successful: \n ${Deno.inspect(jsonBody)}`);
  }

  logger.info(`Abort MultipartUpload Successful`);

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

interface MultipartUploadSession {
  uploadId: string;
  bucket: string;
  objectKey: string;
  initiated: string;
  initiator: { ID: string; DisplayName: string };
  owner: { ID: string; DisplayName: string };
  storageClass: string;
  parts?: Array<unknown>;
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

  // List all JSON files in the multipart uploads directory
  const multipartIndexPrefix = `${MULTIPART_UPLOADS_PATH}/`;
  const listParams = new URLSearchParams();
  listParams.append("prefix", multipartIndexPrefix);
  listParams.append("delimiter", "/");
  // Optionally, set a high limit to get all files (or paginate if needed)
  listParams.append("limit", "1000");
  headers.delete("Accept");
  listParams.append("format", "json");

  const listUrl = `${swiftUrl}/${bucket}?${listParams.toString()}`;

  // Fetch the list of objects in the multipart uploads directory
  const fetchListFunc = async () => {
    return await fetch(listUrl, {
      method: "GET",
      headers: headers,
    });
  };
  const listResponse = await retryWithExponentialBackoff(fetchListFunc);
  if (!isOk(listResponse) || unwrapOk(listResponse).status === 404) {
    logger.error("List Multipart Uploads Failed: ", listResponse);
    return createOk(InternalServerErrorException());
  }

  // Parse the list and filter for .json files
  let uploadJsonFiles: string[] = [];
  try {
    const listData = await unwrapOk(listResponse).json();
    uploadJsonFiles = (listData || [])
      .filter((item: { name: string }) =>
        item.name && item.name.startsWith(multipartIndexPrefix) &&
        item.name.endsWith(".json")
      )
      .map((item: { name: string }) => item.name);
  } catch (error) {
    logger.warn(
      `Error parsing multipart uploads directory listing: ${
        (error as Error).message
      }`,
    );
    return createOk(InternalServerErrorException());
  }

  const uploads: MultipartUploadSession[] = [];
  for (const jsonFile of uploadJsonFiles) {
    const jsonUrl = `${swiftUrl}/${bucket}/${jsonFile}`;
    try {
      const fetchJsonFunc = async () => {
        return await fetch(jsonUrl, {
          method: "GET",
          headers: headers,
        });
      };
      const jsonResponse = await retryWithExponentialBackoff(fetchJsonFunc);
      if (isOk(jsonResponse) && unwrapOk(jsonResponse).ok) {
        const jsonData = await unwrapOk(jsonResponse).json();
        uploads.push(jsonData);
      } else {
        logger.warn(
          `Failed to fetch or parse multipart upload session file: ${jsonFile}`,
        );
      }
    } catch (error) {
      logger.warn(
        `Error fetching multipart upload session file: ${jsonFile}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
      a: MultipartUploadSession,
      b: MultipartUploadSession,
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
    upload: MultipartUploadSession,
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

  logger.info("List MultipartUploads Successful.");

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
