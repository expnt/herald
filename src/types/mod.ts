import { KeystoneTokenStore } from "../backends/swift/keystone_token_store.ts";
import { TaskStore } from "../backends/task_store.ts";

export type HeraldContext = {
  taskStore: TaskStore;
  keystoneStore: KeystoneTokenStore;
};
