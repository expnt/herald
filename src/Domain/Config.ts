import { Option, Schema } from "effect";

export const Credentials = Schema.Struct({
  username: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String),
  accessKeyId: Schema.optional(Schema.String),
  secretAccessKey: Schema.optional(Schema.String),
});

export const BucketOverride = Schema.Struct({
  endpoint: Schema.optional(Schema.String),
  bucket_name: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
});

export type BucketOverride = Schema.Schema.Type<typeof BucketOverride>;

export const BackendConfig = Schema.Struct({
  protocol: Schema.Literal("s3", "swift"),
  endpoint: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  credentials: Schema.optional(Credentials),
  buckets: Schema.optionalWith(
    Schema.Union(
      Schema.Record({ key: Schema.String, value: BucketOverride }),
      Schema.String,
    ),
    { default: () => "*" },
  ),
});

export type BackendConfig = Schema.Schema.Type<typeof BackendConfig>;

export const GlobalConfig = Schema.Struct({
  backends: Schema.Record({ key: Schema.String, value: BackendConfig }),
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
      return Option.some(
        {
          name: bucketName,
          backend_id,
          protocol: backend.protocol,
          endpoint: override.endpoint ?? backend.endpoint,
          region: override.region ?? backend.region,
          bucket_name: override.bucket_name ?? bucketName,
          credentials: backend.credentials,
        } as const,
      );
    }
  }

  // 2. Glob match in any backend's bucket record keys
  for (const [backend_id, backend] of Object.entries(config.backends)) {
    const buckets = backend.buckets;
    if (buckets && typeof buckets !== "string") {
      for (const [key, override] of Object.entries(buckets)) {
        if (globToRegex(key).test(bucketName)) {
          return Option.some(
            {
              name: bucketName,
              backend_id,
              protocol: backend.protocol,
              endpoint: (override as BucketOverride).endpoint ??
                backend.endpoint,
              region: (override as BucketOverride).region ?? backend.region,
              bucket_name: (override as BucketOverride).bucket_name ??
                bucketName,
              credentials: backend.credentials,
            } as const,
          );
        }
      }
    }
  }

  // 3. Glob match if backend.buckets is a string
  for (const [backend_id, backend] of Object.entries(config.backends)) {
    const buckets = backend.buckets;
    if (buckets && typeof buckets === "string") {
      if (globToRegex(buckets).test(bucketName)) {
        return Option.some(
          {
            name: bucketName,
            backend_id,
            protocol: backend.protocol,
            endpoint: backend.endpoint,
            region: backend.region,
            bucket_name: bucketName,
            credentials: backend.credentials,
          } as const,
        );
      }
    }
  }

  return Option.none();
};
