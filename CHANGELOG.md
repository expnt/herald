## 0.6.0 (2025-06-24)

## 0.5.0 (2025-06-23)

### Fix

- use forwarded host during routed requests for signature verification (#45)

## 0.4.0 (2025-06-16)

### Fix

- error propagation (#41)
- remove creds
- remove creds

## 0.3.0 (2025-06-11)

### Feat

- support for pre-signed S3 urls (#37)

### Fix

- stricter S3 response compliance (#35)
- remove creds
- remove creds
- remove creds
- remove creds

## 0.2.0 (2025-04-23)

### Feat

- handle `ListParts` and `AbortMultipartUpload` (#20)

### Fix

- **chart**: remove wrong char (#32)
- release (#30)

## 0.1.0 (2025-04-16)

### Feat

- gitlab proxy support (#19)
- multipart upload (#17)
- update readme (#13)
- add app context (#15)
- add stat of buckets to output (#14)
- replica read when primary down (#10)
- graceful app shutdown (#11)
- s3 comparision python script (#8)
- `jwk` auth (#3)
- prepare github actions (#6)
- **herald**: mirror operations
- add git submodule
- **infra**: multi-env-deploy
- jwk auth
- support additional query params for listObjectsV2 command
- add Dockerfile for the proxy
- **config**: add validation for backup provider configs
- tofu iac support
- **infra**: add config map to mount herald config file
- **infra**: add swift deployment
- setup minio helm provider
- add minio tofu config
- **infra**: add tofu config
- add Dockerfile for the proxy
- **hera-backend**: swift compatibility (#2)
- object upload request proxy (#1)

### Fix

- various bug fixes (#18)
- pagination list objects v2 (#9)
- exoscale missing content-length header error (#7)
- mirror tasks web worker bug (#5)
- add missing backend in herald.yaml configmap
- apt-get doesn't exist in image
- remove deno debian image from deploy job
- fix double encoding issue
- fix url format style identifier
- **swift-backend**: use keystone auth service
- fix minio endpoint in config map
- misinterpretation of hostnames which are IP as virtual-hosted url formats
- **infra**: fix image name issue
- **infra**: fix minio deployment
- **deploy**: fix docker-compose and build file

### Refactor

- worker mgmt (#16)
- change herald config schema (#4)
- fix health-check endpoint on main.tf
- fix health-check endpoint
- fix tf config
- remove comments
