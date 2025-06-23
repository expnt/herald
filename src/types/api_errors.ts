import * as http from "std/http";

export enum APIErrors {
  ErrAuthHeaderEmpty,
  ErrMissingSignHeadersTag,
  ErrInvalidSignHeaders,
  ErrMissingSignTag,
  ErrInvalidSignTag,
  ErrSignatureDoesNotMatch,
  ErrExpiredPresign,
  ErrInvalidRequest, // Added Invalid Request error
  ErrAccessDenied,
}

interface APIError {
  code: string;
  description: string;
  httpStatusCode: number;
  errorSource: "Proxy" | "S3 Server";
}

const errorCodeMap: Record<APIErrors, APIError> = {
  [APIErrors.ErrExpiredPresign]: {
    code: "InvalidArgument",
    description: "The presigned url has expired.",
    httpStatusCode: http.STATUS_CODE.BadRequest,
    errorSource: "Proxy",
  },
  [APIErrors.ErrAuthHeaderEmpty]: {
    code: "InvalidArgument",
    description:
      "Authorization header is invalid -- one and only one ' ' (space) required.",
    httpStatusCode: http.STATUS_CODE.BadRequest,
    errorSource: "Proxy",
  },
  [APIErrors.ErrMissingSignHeadersTag]: {
    code: "InvalidArgument",
    description: "Signature header missing SignedHeaders field.",
    httpStatusCode: http.STATUS_CODE.BadRequest,
    errorSource: "Proxy",
  },
  [APIErrors.ErrInvalidSignHeaders]: {
    code: "InvalidArgument",
    description: "Invalid Signed Headers value",
    httpStatusCode: http.STATUS_CODE.BadRequest,
    errorSource: "Proxy",
  },
  [APIErrors.ErrMissingSignTag]: {
    code: "InvalidArgument",
    description: "Signature header missing SignedHeaders field.",
    httpStatusCode: http.STATUS_CODE.BadRequest,
    errorSource: "Proxy",
  },
  [APIErrors.ErrInvalidSignTag]: {
    code: "InvalidArgument",
    description: "Invalid Signature value",
    httpStatusCode: http.STATUS_CODE.BadRequest,
    errorSource: "Proxy",
  },
  [APIErrors.ErrSignatureDoesNotMatch]: {
    code: "SignatureDoesNotMatch",
    description:
      "The request signature we calculated does not match the signature you provided. Check your key and signing method.",
    httpStatusCode: http.STATUS_CODE.Forbidden,
    errorSource: "Proxy",
  },
  [APIErrors.ErrInvalidRequest]: { // Added Invalid Request mapping
    code: "InvalidRequest",
    description: "The request was malformed or contained an invalid parameter.",
    httpStatusCode: http.STATUS_CODE.BadRequest,
    errorSource: "Proxy",
  },
  [APIErrors.ErrAccessDenied]: {
    code: "AccessDenied", // The standard S3 error code
    description:
      "Direct access to this S3 proxy is not allowed. Requests must originate from a trusted network or proxy.",
    httpStatusCode: http.STATUS_CODE.Forbidden, // http.STATUS_CODE.Forbidden
    errorSource: "Proxy",
  },
};

export function getAPIErrorResponse(error: APIErrors): Response {
  const originalErr = errorCodeMap[error];
  const err = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${originalErr.code}</Code>
  <Message>${originalErr.description}</Message>
  <ErrorSource>${originalErr.errorSource}</ErrorSource>
</Error>`;

  return new Response(err, {
    status: originalErr.httpStatusCode,
    headers: {
      "Content-Type": "application/xml",
      ErrorSource: originalErr.errorSource,
    },
  });
}
