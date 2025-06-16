import { Logger } from "std/log";
import { KeystoneTokenStore } from "../backends/swift/keystone_token_store.ts";
import { TaskStore } from "../backends/task_store.ts";

export type HeraldContext = {
  taskStore: TaskStore;
  keystoneStore: KeystoneTokenStore;
};

export type RequestContext = {
  logger: Logger; //
  heraldContext: HeraldContext;
};
