import { z } from "zod";
import {
  Backend,
  EnvVarConfig,
  GlobalConfig,
  globalConfigSchema,
  ReplicaConfig,
  ReplicaS3Config,
  replicaS3ConfigSchema,
  ReplicaSwiftConfig,
  replicaSwiftConfigSchema,
  S3BucketConfig,
  s3BucketConfigSchema,
  SwiftBucketConfig,
  swiftBucketConfigSchema,
} from "./types.ts";
import { parse } from "@std/yaml";
import { deepMerge } from "std/collections";
import { envVarConfigSchema } from "./types.ts";
import { bucketStore, globalConfig } from "./mod.ts";
import { red } from "std/fmt/colors";
import { Bucket } from "../buckets/mod.ts";

export class ConfigError extends Error {
  // deno-lint-ignore no-explicit-any
  constructor(public issues: any) {
    super(`config error: ${JSON.stringify(issues)}`);
  }
}

async function readYamlFile(yamlFilePath: string) {
  const fileContent = await Deno.readTextFile(yamlFilePath);
  return parse(fileContent);
}

export async function loadConfig(): Promise<GlobalConfig> {
  const envConfig = loadEnvConfig();
  const yamlFilePath = envConfig.config_file_path;

  // deno-lint-ignore no-explicit-any
  const yamlConfig = await readYamlFile(yamlFilePath) as any;

  const rawConfig = yamlConfig;

  const config = configOrExit(
    globalConfigSchema,
    {}, // defaults
    [rawConfig],
  ) as GlobalConfig;

  validateProtocol(config);

  return config;
}

function validateBackupProvidersConfig(
  replicaConfig: ReplicaConfig[],
  backendConfigs: Record<string, Backend>,
) {
  for (const backupConfig of replicaConfig) {
    const bucketName = backupConfig.typ === "ReplicaS3Config"
      ? backupConfig.config.bucket
      : backupConfig.config.container;
    const backendDefinition = backendConfigs[backupConfig.backend];
    if (!backendDefinition) {
      throw new Error(
        `Backend Configuration missing for backup backend: ${backupConfig.backend} with bucket: ${bucketName}`,
      );
    }
    const protocol = backendDefinition.protocol;
    if (protocol === "s3") {
      configOrExit(replicaS3ConfigSchema, {}, [
        backupConfig,
      ]);
    } else {
      configOrExit(replicaSwiftConfigSchema, {}, [
        backupConfig,
      ]);
    }
  }
}

function configToString(
  config:
    | ReplicaS3Config
    | ReplicaSwiftConfig
    | S3BucketConfig
    | SwiftBucketConfig,
) {
  if (config.typ === "ReplicaS3Config" || config.typ === "S3BucketConfig") {
    const conf = config.config;
    return `${conf.endpoint}-${conf.region}-${conf.bucket}`;
  }

  const conf = config.config;
  return `${conf.auth_url}-${conf.region}-${conf.credentials.project_name}-${conf.container}`;
}

function checkDuplicateBackupConfig(
  config: ReplicaConfig[],
) {
  const configs = new Set<string>();
  for (const backup of config) {
    const configStr = configToString(backup);
    if (configs.has(configStr)) {
      throw new Error(
        `Invalid Config: Duplicate providers found for replica: ${backup.name}`,
      );
    }
    configs.add(configStr);
  }
}

function validateProtocol(config: GlobalConfig) {
  const buckets = config.buckets;
  for (const [bucketName, bucketConfig] of Object.entries(buckets)) {
    const backendDefinition = config.backends[bucketConfig.backend];
    if (!backendDefinition) {
      throw new Error(
        `Backend Configuration missing for backend: ${bucketConfig.backend} with bucket: ${bucketName}`,
      );
    }

    const protocol = backendDefinition.protocol;
    if (protocol === "s3") {
      configOrExit(s3BucketConfigSchema, {}, [
        bucketConfig,
      ]);
    } else if (protocol === "swift") {
      configOrExit(swiftBucketConfigSchema, {}, [
        bucketConfig,
      ]);
    } else {
      throw new Error(`Invalid Protocol: ${protocol}`);
    }
  }

  // validate backup providers
  if (config.replicas) {
    validateBackupProvidersConfig(
      config.replicas,
      config.backends,
    );
    checkDuplicateBackupConfig(config.replicas);
  }
}

export function getBackendDef(backendName: string): {
  protocol: "s3" | "swift";
} {
  return globalConfig.backends[backendName]!;
}

export function getBucket(
  bucketName: string,
): Bucket | null {
  return bucketStore.buckets.find((b) => b.name === bucketName) ?? null;
}

export function loadEnvConfig(
  defaults: Partial<EnvVarConfig> = {},
): EnvVarConfig {
  const envVars = Object.keys(envVarConfigSchema.shape)
    .map((k) => k.toUpperCase());

  const config = configOrExit(
    envVarConfigSchema,
    defaults,
    [
      Object.fromEntries(
        envVars
          .map((k) => [k.toLocaleLowerCase(), Deno.env.get(k)])
          .filter(([_, v]) => v !== undefined),
      ),
    ],
  );

  return config as EnvVarConfig;
}

function parseConfig<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  defaults: Partial<z.input<typeof schema>>,
  sources: Array<Record<string, unknown>>,
) {
  const raw = [defaults as Record<string, unknown>, ...sources].reduce(
    (acc, obj) => deepMerge(acc, obj),
    {} as Record<string, unknown>,
  );

  return schema.safeParse(raw);
}

export function configOrThrow<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  defaults: Partial<z.input<typeof schema>>,
  sources: Array<Record<string, unknown>>,
) {
  const result = parseConfig(schema, defaults, sources);
  if (!result.success) {
    throw new ConfigError(result.error.issues);
  }

  return result.data;
}

export function configOrExit<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  defaults: Partial<z.input<typeof schema>>,
  sources: Array<Record<string, unknown>>,
) {
  try {
    return configOrThrow(schema, defaults, sources);
  } catch (e) {
    // deno-lint-ignore no-console
    console.error(red("failed to parse config"));
    if (e instanceof ConfigError) {
      // deno-lint-ignore no-console
      console.error(red(Deno.inspect(e.issues)));
    } else {
      // deno-lint-ignore no-console
      console.error(red(String(e)));
    }
    Deno.exit(1);
  }
}
