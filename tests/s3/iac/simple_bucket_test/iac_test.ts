import { testTerraform } from "../../../utils/iac.ts";
import * as path from "std/path/";
import { testDir } from "../../../utils/mod.ts";

Deno.test("Tofu resource provisioning - S3 backend", async (t) => {
  const tfDir = path.join(testDir, "s3/iac/simple_bucket_test");
  await testTerraform(tfDir, t);
});
