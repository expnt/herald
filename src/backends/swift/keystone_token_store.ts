import { GlobalConfig, SwiftConfig } from "../../config/types.ts";
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
      configAuthMetas.set(configKey, configAuthMeta);
    }

    return new KeystoneTokenStore(
      configAuthMetas,
      swiftConfigs,
    );
  }

  static #getConfigKey(config: SwiftConfig): string {
    // assumed this is enough as a key
    return `${config.auth_url}-${config.region}`;
  }

  static async #getSwiftAuthMeta(config: SwiftConfig): Promise<SwiftAuthMeta> {
    const res: SwiftAuthMeta = await getAuthTokenWithTimeouts(
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
      refreshedAuthMetas.set(configKey, authMeta);
    }
    this.configAuthMetas = refreshedAuthMetas;
  }

  getConfigAuthMeta(
    config: SwiftConfig,
  ): SwiftAuthMeta {
    const key = KeystoneTokenStore.#getConfigKey(config);
    const configMeta = this.configAuthMetas.get(key);
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
