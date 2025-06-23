import { BucketStore, initializeBucketStore } from "../buckets/mod.ts";
import {
  getBucket,
  initializeTrustedCidrs,
  loadConfig,
  loadEnvConfig,
} from "./loader.ts";
import {
  EnvVarConfig,
  GlobalConfig,
  PreprocessedTrustedCidrs,
  S3BucketConfig,
  SwiftBucketConfig,
} from "./types.ts";

// types export
export type { S3BucketConfig, S3Config, SwiftBucketConfig } from "./types.ts";

export const getS3Config = (bucketName: string) =>
  getBucket(bucketName) as S3BucketConfig;
export const getSwiftConfig = (bucketName: string) =>
  getBucket(bucketName) as SwiftBucketConfig;
export let globalConfig: GlobalConfig;
export let envVarsConfig: EnvVarConfig;
export { getBackendDef } from "./loader.ts";
export let proxyUrl: string;
export let bucketStore: BucketStore;
export let trustedCidrs: PreprocessedTrustedCidrs = [];

export async function configInit() {
  globalConfig = await loadConfig();
  envVarsConfig = loadEnvConfig({
    sentry_sample_rate: 1,
    sentry_traces_sample_rate: 1,
  });
  proxyUrl = `http://localhost:${globalConfig.port}`;
  bucketStore = initializeBucketStore(globalConfig);
  trustedCidrs = initializeTrustedCidrs(globalConfig.trusted_ips);
}

await configInit();
