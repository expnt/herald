import { Effect } from "effect";
import { assertEquals, testEffect } from "./utils.ts";
import {
  parseCompleteMultipartUploadRequest,
  parseDeleteObjectsRequest,
} from "../src/Services/XmlParser.ts";

testEffect(
  "xmlparser/deleteObjects/decodesSpecialKeyEntities",
  () =>
    Effect.gen(function* () {
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<Delete>
  <Object><Key>&amp;</Key></Object>
  <Object><Key>&lt;</Key></Object>
  <Object><Key>&gt;</Key></Object>
  <Object><Key>quote&quot;key&apos;plus</Key></Object>
  <Object><Key>a&amp;lt;b</Key></Object>
</Delete>`;
      const objects = yield* parseDeleteObjectsRequest(body);
      assertEquals(objects.map((o) => o.key), [
        "&",
        "<",
        ">",
        "quote\"key'plus",
        // double escape: &amp;lt; must resolve to the literal "&lt;", not "<"
        "a&lt;b",
      ]);
    }),
);

testEffect(
  "xmlparser/deleteObjects/decodesNumericReferences",
  () =>
    Effect.gen(function* () {
      const body =
        `<Delete><Object><Key>x&#38;y&#65;&#x42;z</Key></Object></Delete>`;
      const objects = yield* parseDeleteObjectsRequest(body);
      assertEquals(objects[0].key, "x&yABz");
    }),
);

testEffect(
  "xmlparser/completeMultipartUpload/decodesEtagEntities",
  () =>
    Effect.gen(function* () {
      const body = `<CompleteMultipartUpload>
  <Part><PartNumber>1</PartNumber><ETag>&quot;abc123&quot;</ETag></Part>
</CompleteMultipartUpload>`;
      const parts = yield* parseCompleteMultipartUploadRequest(body);
      assertEquals(parts[0].etag, '"abc123"');
      assertEquals(parts[0].partNumber, 1);
    }),
);
