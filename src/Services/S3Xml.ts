import { Context, Layer } from "effect"
import { HttpServerResponse } from "@effect/platform"
import {
  type BucketInfo,
  type OwnerInfo,
  NoSuchBucket,
  NoSuchKey,
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  InternalError,
  AccessDenied
} from "./Backend.ts"

export class S3Xml extends Context.Tag("S3Xml")<
  S3Xml,
  {
    readonly formatError: (e: unknown, isHead?: boolean) => HttpServerResponse.HttpServerResponse
    readonly formatListBuckets: (buckets: readonly BucketInfo[], owner: OwnerInfo) => HttpServerResponse.HttpServerResponse
  }
>() { }

export const S3XmlLive = Layer.succeed(
  S3Xml,
  S3Xml.of({
    formatError: (e, isHead = false) => {
      let code = "InternalError"
      let message = "An internal error occurred"
      let status = 500

      if (e instanceof NoSuchBucket) {
        code = "NoSuchBucket"
        message = e.message
        status = 404
      } else if (e instanceof NoSuchKey) {
        code = "NoSuchKey"
        message = e.message
        status = 404
      } else if (e instanceof BucketAlreadyExists) {
        code = "BucketAlreadyExists"
        message = e.message
        status = 409
      } else if (e instanceof BucketAlreadyOwnedByYou) {
        code = "BucketAlreadyOwnedByYou"
        message = e.message
        status = 409
      } else if (e instanceof AccessDenied) {
        code = "AccessDenied"
        message = e.message
        status = 403
      } else if (e instanceof InternalError) {
        code = "InternalError"
        message = e.message
        status = 500
      } else if (e instanceof Error) {
        message = e.message
      } else if (typeof e === "string") {
        message = e
      }

      if (isHead) {
        return HttpServerResponse.raw(null, { status })
      }

      const xml = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`

      return HttpServerResponse.text(xml, {
        status,
        headers: {
          "Content-Type": "application/xml"
        }
      })
    },

    formatListBuckets: (buckets, owner) => {
      const bucketsXml = buckets.map(b => `<Bucket><Name>${b.name}</Name><CreationDate>${b.creationDate?.toISOString()}</CreationDate></Bucket>`).join("")

      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>${owner.id}</ID><DisplayName>${owner.displayName}</DisplayName></Owner><Buckets>${bucketsXml}</Buckets></ListAllMyBucketsResult>`

      return HttpServerResponse.text(xml, {
        headers: {
          "Content-Type": "application/xml"
        }
      })
    }
  })
)
