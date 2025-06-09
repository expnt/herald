import * as http from "std/http";

export enum APIErrors {
  ErrAuthHeaderEmpty,
  ErrMissingSignHeadersTag,
  ErrInvalidSignHeaders,
  ErrMissingSignTag,
  ErrInvalidSignTag,
  ErrSignatureDoesNotMatch,
  ErrExpiredPresign,
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
};

export function getAPIErrorResponse(error: APIErrors): Response {
  const err = errorCodeMap[error];

  return new Response(err.description, {
    status: err.httpStatusCode,
    headers: {
      ErrorSource: err.errorSource,
    },
  });
}
