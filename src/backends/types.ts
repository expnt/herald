import {
  BackupS3Config,
  BackupSwiftConfig,
  S3BucketConfig,
  SwiftBucketConfig,
} from "../config/types.ts";

export type MirrorableCommands =
  | "putObject"
  | "deleteObject"
  | "copyObject"
  | "createBucket"
  | "deleteBucket";

export interface WorkerEvent {
  data: MirrorTask;
}

/**
 * Interface representing a task to mirror a specific operation between two bucket configurations.
 */
export interface MirrorTask {
  mainBucketConfig: S3BucketConfig | SwiftBucketConfig;
  backupBucketConfig: BackupS3Config | BackupSwiftConfig;
  command: MirrorableCommands;
  originalRequest: Record<string, unknown>;
  nonce: string;
}