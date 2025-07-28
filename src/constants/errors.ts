const commonHeaders = {
  "Content-Type": "application/xml",
};

// xml error responses
const noSuchBucketXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchBucket</Code>
  <Message>The specified bucket does not exist</Message>
  <BucketName>example-bucket</BucketName>
  <RequestId>EXAMPLE123456789</RequestId>
  <HostId>EXAMPLEhostIDString1234567890123456789012345678901234567890</HostId>
</Error>`;

// Exceptions
export function NoSuchBucketException() {
  return new Response(noSuchBucketXml, {
    status: 404,
    headers: commonHeaders,
  });
}

export function NotImplementedException() {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NotImplemented</Code>
  <Message>Method Not Implemented.</Message>
  <RequestId>EXAMPLE123456789</RequestId>
  <HostId>EXAMPLEhostIDString1234567890123456789012345678901234567890</HostId>
</Error>`,
    {
      status: 501,
      headers: commonHeaders,
    },
  );
}

export function MethodNotAllowedException(method: string) {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>MethodNotAllowed</Code>
  <Message>The specified method is not allowed against this resource.</Message>
  <Method>${method}</Method>
  <ResourceType>Bucket</ResourceType>
  <RequestId>EXAMPLE123456789</RequestId>
  <HostId>EXAMPLEhostIDString1234567890123456789012345678901234567890</HostId>
</Error>`,
    {
      status: 405,
      headers: commonHeaders,
    },
  );
}

// xml error response for NoSuchBucketConfiguration
const noSuchBucketConfigurationXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchBucketConfiguration</Code>
  <Message>The specified bucket does not have a valid configuration</Message>
  <BucketName>example-bucket</BucketName>
  <RequestId>EXAMPLE123456789</RequestId>
  <HostId>EXAMPLEhostIDString1234567890123456789012345678901234567890</HostId>
</Error>`;

export function NoSuchBucketConfigurationException() {
  return new Response(noSuchBucketConfigurationXml, {
    status: 404,
    headers: commonHeaders,
  });
}

// xml error response for NoSuchUpload
const noSuchUploadXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchUpload</Code>
  <Message>The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.</Message>
  <RequestId>EXAMPLE123456789</RequestId>
  <HostId>EXAMPLEhostIDString1234567890123456789012345678901234567890</HostId>
</Error>`;

export function NoSuchUploadException() {
  return new Response(noSuchUploadXml, {
    status: 404,
    headers: commonHeaders,
  });
}

// xml error response for MissingUploadId
const missingUploadIdXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>InvalidRequest</Code>
  <Message>Missing required parameter uploadId</Message>
  <RequestId>EXAMPLE123456789</RequestId>
  <HostId>EXAMPLEhostIDString1234567890123456789012345678901234567890</HostId>
</Error>`;

export function MissingUploadIdException() {
  return new Response(missingUploadIdXml, {
    status: 400,
    headers: commonHeaders,
  });
}

// xml error response for InvalidRequest
const invalidRequestXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>InvalidRequest</Code>
  <Message>The request is invalid.</Message>
  <RequestId>EXAMPLE123456789</RequestId>
  <HostId>EXAMPLEhostIDString1234567890123456789012345678901234567890</HostId>
</Error>`;

export function InvalidRequestException(message?: string) {
  const customXml = message
    ? invalidRequestXml.replace("The request is invalid.", message)
    : invalidRequestXml;

  return new Response(customXml, {
    status: 400,
    headers: commonHeaders,
  });
}

const malformedXmlError = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>MalformedXML</Code>
    <Message>The XML you provided was not well-formed or did not satisfy the required schema.</Message>
    <RequestId>unique-request-id</RequestId>
    <HostId>unique-host-id</HostId>
    <UploadId>your-upload-id</UploadId> <!-- The upload ID from the original request -->
</Error>`;
export function MalformedXMLException(message?: string) {
  const customXml = message
    ? malformedXmlError.replace("The request is invalid.", message)
    : malformedXmlError;

  return new Response(customXml, {
    status: 400,
    headers: commonHeaders,
  });
}

export function InternalServerErrorException(requestId = "unknown") {
  // xml error response for InternalServerError
  const internalServerErrorXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>InternalServerError</Code>
  <Message>We encountered an internal error. Please try again.</Message>
  <RequestId>${requestId}</RequestId>
  <HostId>1234567890123456789012345678901234567890</HostId>
</Error>`;
  return new Response(internalServerErrorXml, {
    status: 500,
    headers: commonHeaders,
  });
}
