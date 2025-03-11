import { S3ClientConfig } from "aws-sdk/client-s3";
import * as path from "std/path";

export const testDir = path.join(Deno.cwd(), "tests/");

// deno-lint-ignore require-await no-explicit-any
export const loggingMiddleware = (next: any) => async (args: any) => {
  const { request } = args;
  // deno-lint-ignore no-console
  console.log("Request Details:", {
    url:
      `${request.protocol}//${request.hostname}:${request.port}${request.path}`,
    method: request.method,
    hostname: request.hostname,
    path: request.path,
    headers: request.headers,
  });
  return next(args);
};

export const testConfig: S3ClientConfig = {
  credentials: {
    accessKeyId: "minio",
    secretAccessKey: "password",
  },
  endpoint: "http://localhost:9000",
  region: "local",
  forcePathStyle: true,
};
