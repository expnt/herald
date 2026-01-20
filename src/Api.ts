import { HttpApi, OpenApi } from "@effect/platform";
import { HealthApi } from "./Frontend/Health/Api.ts";
import { S3Api } from "./Frontend/Api.ts";

export class Api extends HttpApi.make("api")
  .add(HealthApi)
  .add(S3Api)
  .annotate(OpenApi.Title, "Herald API") {}
