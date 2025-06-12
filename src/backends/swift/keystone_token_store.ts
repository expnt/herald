import { GlobalConfig, SwiftConfig } from "../../config/types.ts";
import { reportToSentry } from "../../utils/log.ts";
import { getAuthTokenWithTimeouts } from "./auth.ts";

interface SwiftAuthMeta {
  token: string;
  storageUrl: string;
}

export class KeystoneTokenStore {
  constructor(
    private configAuthMetas: Map<string, SwiftAuthMeta>,
    private configs: SwiftConfig[],
  ) {}

  public static async initializeStore(
    swiftConfigs: SwiftConfig[],
  ): Promise<KeystoneTokenStore> {
    const configAuthMetas = new Map<string, SwiftAuthMeta>();
    for (const config of swiftConfigs) {
      const configKey = KeystoneTokenStore.#getConfigKey(config);
      if (configAuthMetas.has(configKey)) {
        continue;
      }
      const configAuthMeta = await KeystoneTokenStore.#getSwiftAuthMeta(config);
      if (configAuthMeta instanceof Error) {
        reportToSentry(
          `Failed to fetch Swift Auth Meta: ${configAuthMeta.message}`,
        );
      } else {
        configAuthMetas.set(configKey, configAuthMeta);
      }
    }

    return new KeystoneTokenStore(
      configAuthMetas,
      swiftConfigs,
    );
  }

  // Convert to a format that can be passed to the worker
  public toSerializable(): {
    configAuthMetas: [string, SwiftAuthMeta][];
    configs: SwiftConfig[];
  } {
    return {
      configAuthMetas: Array.from(this.configAuthMetas.entries()), // Convert Map to array
      configs: this.configs, // Arrays are already serializable
    };
  }

  // Reconstruct from the serialized format
  public static fromSerializable(
    data: { configAuthMetas: [string, object][]; configs: object[] },
  ): KeystoneTokenStore {
    return new KeystoneTokenStore(
      new Map(data.configAuthMetas as [string, SwiftAuthMeta][]),
      data.configs as SwiftConfig[],
    );
  }

  static #getConfigKey(config: SwiftConfig): string {
    // assumed this is enough as a key
    return `${config.auth_url}-${config.region}`;
  }

  static async #getSwiftAuthMeta(
    config: SwiftConfig,
  ): Promise<SwiftAuthMeta | Error> {
    const res: SwiftAuthMeta | Error = await getAuthTokenWithTimeouts(
      config,
    );

    return res;
  }

  async refreshTokens(): Promise<void> {
    const refreshedAuthMetas = new Map<string, SwiftAuthMeta>();
    for (const config of this.configs) {
      const configKey = KeystoneTokenStore.#getConfigKey(config);
      if (refreshedAuthMetas.has(configKey)) {
        continue;
      }
      const authMeta = await KeystoneTokenStore.#getSwiftAuthMeta(config);
      if (authMeta instanceof Error) {
        reportToSentry(`Failed to fetch Swift Auth Meta: ${authMeta.message}`);
        return;
      }
      refreshedAuthMetas.set(configKey, authMeta);
    }
    this.configAuthMetas = refreshedAuthMetas;
  }

  getConfigAuthMeta(
    config: SwiftConfig,
  ): SwiftAuthMeta {
    const key = KeystoneTokenStore.#getConfigKey(config);
    const configMeta = this.configAuthMetas.get(key);

    // logically unreachable
    if (!configMeta) {
      throw new Error(
        "Application error: a swift storage config with no auth tokens found",
      );
    }

    return configMeta;
  }
}

export const initKeystoneStore = async (config: GlobalConfig) => {
  const swiftConfigs: SwiftConfig[] = [];
  for (const [_, bucketConfig] of Object.entries(config.buckets)) {
    if (bucketConfig.typ === "SwiftBucketConfig") {
      swiftConfigs.push(bucketConfig.config);
    }
  }
  for (const [_, replicaBucketConfig] of Object.entries(config.replicas)) {
    if (replicaBucketConfig.typ === "ReplicaSwiftConfig") {
      swiftConfigs.push(replicaBucketConfig.config);
    }
  }

  const keystoneStore = await KeystoneTokenStore.initializeStore(
    swiftConfigs,
  );

  // update the tokens every 55 minutes
  setInterval(async () => {
    await keystoneStore.refreshTokens();
  }, 55 * 60 * 1000); // 55 minutes in milliseconds

  return keystoneStore;
};
