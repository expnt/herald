import { Option, Schema } from "effect";

export const S3Credentials = Schema.Struct({
  accessKeyId: Schema.optional(Schema.String),
  secretAccessKey: Schema.optional(Schema.String),
});

export const SwiftCredentials = Schema.Struct({
  username: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String),
  project_name: Schema.optional(Schema.String),
  user_domain_name: Schema.optional(Schema.String),
  project_domain_name: Schema.optional(Schema.String),
});

export const Credentials = Schema.Union(S3Credentials, SwiftCredentials);

export const CorsConfig = Schema.Struct({
  allowedOrigins: Schema.optional(Schema.Array(Schema.String)),
  allowedMethods: Schema.optional(Schema.Array(Schema.String)),
  allowedHeaders: Schema.optional(Schema.Array(Schema.String)),
  exposedHeaders: Schema.optional(Schema.Array(Schema.String)),
  maxAge: Schema.optional(Schema.Number),
  credentials: Schema.optional(Schema.Boolean),
});

export type CorsConfig = Schema.Schema.Type<typeof CorsConfig>;

export const BucketOverride = Schema.Struct({
  endpoint: Schema.optional(Schema.String),
  bucket_name: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  cors: Schema.optional(CorsConfig),
});

export type BucketOverride = Schema.Schema.Type<typeof BucketOverride>;

export const BucketsConfig = Schema.optionalWith(
  Schema.Union(
    Schema.Record({ key: Schema.String, value: BucketOverride }),
    Schema.String,
  ),
  { default: () => "*" },
);

export const S3Config = Schema.Struct({
  protocol: Schema.Literal("s3"),
  endpoint: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  credentials: Schema.optional(S3Credentials),
  buckets: BucketsConfig,
  cors: Schema.optional(CorsConfig),
});

export const SwiftConfig = Schema.Struct({
  protocol: Schema.Literal("swift"),
  auth_url: Schema.String,
  region: Schema.optional(Schema.String),
  container: Schema.optional(Schema.String),
  credentials: Schema.optional(SwiftCredentials),
  buckets: BucketsConfig,
  cors: Schema.optional(CorsConfig),
});

export const BackendConfig = Schema.Union(S3Config, SwiftConfig);

export type BackendConfig = Schema.Schema.Type<typeof BackendConfig>;

export const GlobalConfig = Schema.Struct({
  backends: Schema.Record({ key: Schema.String, value: BackendConfig }),
  cors: Schema.optional(CorsConfig),
});

export type GlobalConfig = Schema.Schema.Type<typeof GlobalConfig>;

export const MaterializedBucket = Schema.Struct({
  name: Schema.String,
  backend_id: Schema.String,
  protocol: Schema.Literal("s3", "swift"),
  endpoint: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  bucket_name: Schema.String,
  credentials: Schema.optional(Credentials),
  // Swift specific
  auth_url: Schema.optional(Schema.String),
  container: Schema.optional(Schema.String),
});

export type MaterializedBucket = Schema.Schema.Type<typeof MaterializedBucket>;

/**
 * Utility to convert simple glob (*) to RegExp
 */
export const globToRegex = (glob: string) => {
  const regexStr = glob.split("*").map((s) =>
    s.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  ).join(".*");
  return new RegExp(`^${regexStr}$`);
};

export const lookupBucket = (
  config: GlobalConfig,
  bucketName: string,
): Option.Option<MaterializedBucket> => {
  // 1. Direct hit in any backend's bucket record
  for (const [backend_id, backend] of Object.entries(config.backends)) {
    const buckets = backend.buckets;
    if (buckets && typeof buckets !== "string" && buckets[bucketName]) {
      const override = buckets[bucketName];
      const base: MaterializedBucket = {
        name: bucketName,
        backend_id,
        protocol: backend.protocol,
        endpoint: override.endpoint ??
          (backend.protocol === "s3" ? backend.endpoint : undefined),
        region: override.region ?? backend.region,
        bucket_name: override.bucket_name ?? bucketName,
        credentials: backend.credentials,
        auth_url: backend.protocol === "swift" ? backend.auth_url : undefined,
        container: backend.protocol === "swift" ? backend.container : undefined,
      };

      return Option.some(base);
    }
  }

  // 2. Glob match in any backend's bucket record keys
  for (const [backend_id, backend] of Object.entries(config.backends)) {
    const buckets = backend.buckets;
    if (buckets && typeof buckets !== "string") {
      for (const [key, override] of Object.entries(buckets)) {
        if (globToRegex(key).test(bucketName)) {
          const base: MaterializedBucket = {
            name: bucketName,
            backend_id,
            protocol: backend.protocol,
            endpoint: (override as BucketOverride).endpoint ??
              (backend.protocol === "s3" ? backend.endpoint : undefined),
            region: (override as BucketOverride).region ?? backend.region,
            bucket_name: (override as BucketOverride).bucket_name ??
              bucketName,
            credentials: backend.credentials,
            auth_url: backend.protocol === "swift"
              ? backend.auth_url
              : undefined,
            container: backend.protocol === "swift"
              ? backend.container
              : undefined,
          };

          return Option.some(base);
        }
      }
    }
  }

  // 3. Glob match if backend.buckets is a string
  for (const [backend_id, backend] of Object.entries(config.backends)) {
    const buckets = backend.buckets;
    if (buckets && typeof buckets === "string") {
      if (globToRegex(buckets).test(bucketName)) {
        const base: MaterializedBucket = {
          name: bucketName,
          backend_id,
          protocol: backend.protocol,
          endpoint: backend.protocol === "s3" ? backend.endpoint : undefined,
          region: backend.region,
          bucket_name: bucketName,
          credentials: backend.credentials,
          auth_url: backend.protocol === "swift" ? backend.auth_url : undefined,
          container: backend.protocol === "swift"
            ? backend.container
            : undefined,
        };

        return Option.some(base);
      }
    }
  }

  return Option.none();
};

export const resolveCorsConfig = (
  config: GlobalConfig,
  bucketName: string,
): CorsConfig | undefined => {
  // 1. Find the backend and bucket override
  let bucketCors: CorsConfig | undefined;
  let backendCors: CorsConfig | undefined;

  for (const backend of Object.values(config.backends)) {
    const buckets = backend.buckets;
    if (buckets && typeof buckets !== "string" && buckets[bucketName]) {
      bucketCors = buckets[bucketName].cors;
      backendCors = backend.cors;
      break;
    }
  }

  // If not found by direct hit, try glob match (similar to lookupBucket)
  if (!bucketCors) {
    for (const backend of Object.values(config.backends)) {
      const buckets = backend.buckets;
      if (buckets && typeof buckets !== "string") {
        for (const [key, override] of Object.entries(buckets)) {
          if (globToRegex(key).test(bucketName)) {
            bucketCors = (override as BucketOverride).cors;
            backendCors = backend.cors;
            break;
          }
        }
      }
      if (bucketCors) break;
    }
  }

  // If still not found, check if it's a general backend match
  if (!bucketCors && !backendCors) {
    for (const backend of Object.values(config.backends)) {
      const buckets = backend.buckets;
      if (
        typeof buckets === "string" && globToRegex(buckets).test(bucketName)
      ) {
        backendCors = backend.cors;
        break;
      }
    }
  }

  const globalCors = config.cors;

  if (!bucketCors && !backendCors && !globalCors) {
    return undefined;
  }

  // Merge with precedence: bucket > backend > global
  return {
    ...globalCors,
    ...backendCors,
    ...bucketCors,
  };
};
