import { z } from "zod";
import IPCIDR from "ip-cidr";

const backendSchema = z.object({
  protocol: z.enum(["s3", "swift"]),
});
export type Backend = z.infer<typeof backendSchema>;

const loadFromEnv = (key: string, fallback: string): string => {
  return Deno.env.get(key) ?? fallback;
};

export const s3ConfigSchema = z.object({
  endpoint: z.string(),
  region: z.string(),
  bucket: z.string(),
  forcePathStyle: z.boolean(),
  credentials: z.object({
    accessKeyId: z.string().transform((key) =>
      key.startsWith("fromEnv:") ? loadFromEnv(key.substring(8), key) : key
    ),
    secretAccessKey: z.string().transform((key) =>
      key.startsWith("fromEnv:") ? loadFromEnv(key.substring(8), key) : key
    ),
  }),
  typ: z.literal("S3Config").default("S3Config"),
});
export type S3Config = z.infer<typeof s3ConfigSchema>;

export const swiftConfigSchema = z.object({
  auth_url: z.string(),
  container: z.string(),
  region: z.string(),
  credentials: z.object({
    username: z.string().transform((key) =>
      key.startsWith("fromEnv:") ? loadFromEnv(key.substring(8), key) : key
    ),
    password: z.string().transform((key) =>
      key.startsWith("fromEnv:") ? loadFromEnv(key.substring(8), key) : key
    ),
    project_name: z.string().transform((key) =>
      key.startsWith("fromEnv:") ? loadFromEnv(key.substring(8), key) : key
    ),
    user_domain_name: z.string(),
    project_domain_name: z.string(),
  }),
  typ: z.literal("SwiftConfig").default("SwiftConfig"),
});
export type SwiftConfig = z.infer<typeof swiftConfigSchema>;

export const s3BucketConfigSchema = z.object({
  backend: z.string(),
  config: s3ConfigSchema,
  typ: z.literal("S3BucketConfig").default("S3BucketConfig"),
});
export type S3BucketConfig = z.infer<typeof s3BucketConfigSchema>;

export const swiftBucketConfigSchema = z.object({
  backend: z.string(),
  config: swiftConfigSchema,
  typ: z.literal("SwiftBucketConfig").default("SwiftBucketConfig"),
});
export type SwiftBucketConfig = z.infer<typeof swiftBucketConfigSchema>;

export type BucketConfig = S3BucketConfig | SwiftBucketConfig;

export const replicaS3ConfigSchema = z.object({
  name: z.string(),
  backend: z.string(),
  config: s3ConfigSchema,
  typ: z.literal("ReplicaS3Config").default("ReplicaS3Config"),
});
export type ReplicaS3Config = z.infer<typeof replicaS3ConfigSchema>;

export const replicaSwiftConfigSchema = z.object({
  name: z.string(),
  backend: z.string(),
  config: swiftConfigSchema,
  typ: z.literal("ReplicaSwiftConfig").default("ReplicaSwiftConfig"),
});
export type ReplicaSwiftConfig = z.infer<typeof replicaSwiftConfigSchema>;

export const replicaConfigSchema = z.union([
  replicaS3ConfigSchema,
  replicaSwiftConfigSchema,
]);
export type ReplicaConfig = z.infer<typeof replicaConfigSchema>;
// deno-lint-ignore no-explicit-any
export function isBucketConfig(config: any): config is BucketConfig {
  return config.typ === "S3BucketConfig" || config.typ === "SwiftBucketConfig";
}

// deno-lint-ignore no-explicit-any
export function isReplicaConfig(config: any): config is ReplicaConfig {
  return config.typ === "ReplicaS3Config" ||
    config.typ === "ReplicaSwiftConfig";
}

export const serviceAccountAccessSchema = z.object({
  name: z.string(),
  // FIXME: Accept a regex for the bucket name
  buckets: z.array(z.string()),
});
export type ServiceAccountAccess = z.infer<
  typeof serviceAccountAccessSchema
>;

export const globalConfigSchema = z.object({
  port: z.number().int(),
  service_accounts: z.array(serviceAccountAccessSchema),
  trust_proxy: z.boolean().default(false),
  trusted_ips: z.array(
    z.cidrv4(),
  ).default([]),
  temp_dir: z.string(),
  task_store_backend: z.union([s3ConfigSchema, swiftConfigSchema]),
  backends: z.record(z.string(), backendSchema),
  default_bucket: z.string().nonoptional().describe(
    "The main bucket where operations with no bucket specified will be directed to.",
  ),
  buckets: z.record(
    z.string(),
    z.union([
      s3BucketConfigSchema,
      swiftBucketConfigSchema,
    ]),
  ),
  replicas: z.array(replicaConfigSchema),
  cors: z.object({
    // Allow a single host value or a list of host values.
    // Examples: "*", "example.com", "*.example.com", "https://app.example.com"
    host: z.union([z.string(), z.array(z.string())]).default(""),
  }).default({ host: "" }),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;

const zBooleanString = z.preprocess(
  (a: unknown) => z.coerce.string().parse(a) === "true",
  z.boolean(),
);

export const envVarConfigSchema = z.object({
  debug: zBooleanString,
  log_level: z
    .enum(["NOTSET", "DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"])
    .optional(),
  env: z.enum(["DEV", "PROD"]).default("DEV"),
  k8s_api: z.string().default("https://kubernetes.default.svc"),
  cert_path: z.string().default(
    "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
  ),
  config_file_path: z.string().default("herald.yaml"),
  auth_type: z.enum(["service_account", "default"]).default("default"),
  service_account_token_path: z.string().default(
    "/var/run/secrets/kubernetes.io/serviceaccount/token",
  ),
  version: z.string().default("0.1"),
  sentry_dsn: z.string().optional(),
  sentry_sample_rate: z.coerce.number().positive().min(0).max(1).default(1),
  sentry_traces_sample_rate: z.coerce.number().positive().min(0).max(1).default(
    1,
  ),
});
export type EnvVarConfig = z.infer<typeof envVarConfigSchema>;

export function convertReplicaToPrimary(replica: ReplicaConfig): BucketConfig {
  if (replica.typ === "ReplicaS3Config") {
    return {
      backend: replica.backend,
      config: replica.config,
      typ: "S3BucketConfig",
    };
  } else {
    return {
      backend: replica.backend,
      config: replica.config,
      typ: "SwiftBucketConfig",
    };
  }
}

export type PreprocessedTrustedCidrs = IPCIDR[];
