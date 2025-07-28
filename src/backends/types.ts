import { Bucket } from "../buckets/mod.ts";

export type MirrorableCommands =
  | "putObject"
  | "deleteObject"
  | "deleteObjects"
  | "copyObject"
  | "createBucket"
  | "deleteBucket"
  | "completeMultipartUpload";

export interface WorkerEvent {
  data: MirrorTask;
}

/**
 * Interface representing a task to mirror a specific operation between two bucket configurations.
 */
export interface MirrorTask {
  mainBucketConfig: Bucket;
  backupBucketConfig: Bucket;
  command: MirrorableCommands;
  originalRequest: Record<string, unknown>;
  nonce: string;
  retryCount: number;
  stringBody?: string | undefined;
}
