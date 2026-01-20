import { HttpApi, OpenApi } from "@effect/platform";
import { HealthHttpApi } from "./Frontend/Health/Api.ts";
import { HttpS3Api } from "./Frontend/Api.ts";

// the http interface is declared first and separately
// and the impl is to adhere to it
// used for openAPI
export class HttpHeraldApi extends HttpApi.make("HeraldHttpApi")
  .add(HealthHttpApi)
  .add(HttpS3Api)
  .annotate(OpenApi.Title, "Herald API") {}
