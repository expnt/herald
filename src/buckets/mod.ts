import { S3Config } from "../config/mod.ts";
import { GlobalConfig, SwiftConfig } from "../config/types.ts";

export interface BucketStore {
  buckets: Bucket[];
}

export class Bucket {
  constructor(
    private _name: string,
    private _config: S3Config | SwiftConfig,
    private _replicas: Bucket[],
    private _typ: string,
    private _backend: string,
  ) {}

  public static fromJSON(json: {
    _name: string;
    _config: S3Config | SwiftConfig;
    _replicas?: object[];
    _typ: string;
    _backend: string;
  }): Bucket {
    const replicas = json._replicas
      // deno-lint-ignore no-explicit-any
      ? json._replicas.map((replicaJson: any) => Bucket.fromJSON(replicaJson))
      : [];
    return new Bucket(
      json._name,
      json._config,
      replicas,
      json._typ,
      json._backend,
    );
  }

  public getReplica(name: string) {
    return this.replicas.find((replica) => replica.name === name);
  }

  get name() {
    return this._name;
  }

  get bucketName() {
    return this.typ === "S3BucketConfig" || this.typ === "ReplicaS3Config"
      ? (this.config as S3Config).bucket
      : (this.config as SwiftConfig).container;
  }

  public hasReplicas() {
    return this.replicas.length > 0;
  }

  get replicas() {
    return this._replicas;
  }

  get config() {
    return this._config;
  }

  get typ() {
    return this._typ;
  }

  get backend() {
    return this._backend;
  }

  get isReplica() {
    return this.typ == "ReplicaS3Config" || this.typ == "ReplicaSwiftConfig";
  }
}

export function initializeBucketStore(config: GlobalConfig): BucketStore {
  const buckets = [];
  for (const [name, bucketConfig] of Object.entries(config.buckets)) {
    const bucketName = bucketConfig.typ === "S3BucketConfig"
      ? bucketConfig.config.bucket
      : bucketConfig.config.container;
    const replicas = config.replicas.filter((replica) => {
      const replicaBucketName = replica.typ === "ReplicaS3Config"
        ? replica.config.bucket
        : replica.config.container;
      return replicaBucketName === bucketName;
    }).map((replica) =>
      new Bucket(replica.name, replica.config, [], replica.typ, replica.backend)
    );
    const bucket = new Bucket(
      name,
      bucketConfig.config,
      replicas,
      bucketConfig.typ,
      bucketConfig.backend,
    );
    buckets.push(bucket);
  }

  // task store bucket
  const taskStoreConfig = config.task_store_backend;
  const taskStoreBucket = taskStoreConfig.typ === "S3Config"
    ? new Bucket(
      "task-store",
      taskStoreConfig,
      [],
      taskStoreConfig.typ,
      "s3",
    )
    : new Bucket(
      "task-store",
      taskStoreConfig,
      [],
      taskStoreConfig.typ,
      "swift",
    );
  buckets.push(taskStoreBucket);

  return {
    buckets,
  };
}
