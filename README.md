<p align="center">
    <img src="https://raw.githubusercontent.com/PKief/vscode-material-icon-theme/ec559a9f6bfd399b82bb44393651661b08aaf7ba/icons/folder-markdown-open.svg" align="center" width="30%">
</p>
<p align="center"><h1 align="center">herald</h1></p>
<p align="center">
	<em>herald: Orchestrating object storage services</em>
</p>
<p align="center">
	<img src="https://img.shields.io/github/license/expnt/herald?style=default&logo=opensourceinitiative&logoColor=white&color=0080ff" alt="license">
	<img src="https://img.shields.io/github/last-commit/expnt/herald?style=default&logo=git&logoColor=white&color=0080ff" alt="last-commit">
	<img src="https://img.shields.io/github/languages/top/expnt/herald?style=default&color=0080ff" alt="repo-top-language">
	<img src="https://img.shields.io/github/languages/count/expnt/herald?style=default&color=0080ff" alt="repo-language-count">
</p>
<p align="center"><!-- default option, no dependency badges. -->
</p>
<p align="center">
	<!-- default option, no dependency badges. -->
</p>
<br>

## Table of Contents

- [ Overview](#Overview)
- [ Features](#Features)
- [ Project Structure](#Project-Structure)
- [ Getting Started](#Getting-Started)
  - [ Prerequisites](#Prerequisites)
  - [ Development](#Development)
  - [ herald.yaml config file](#herald.yaml-config-file)
  - [ Environment Variables](#Environment-Variables)
  - [ Usage](#Usage)
  - [ Testing](#Testing)
- [ Project Roadmap](#Project-Roadmap)
- [ Contributing](#Contributing)
- [ Acknowledgments](#Acknowledgments)

---

## Overview

Herald is an S3 proxy that allows communication to multiple storage services with different communication protocols using the S3 protocol. For instance, you can use herald to connect to an OpenStack swift storage service as you would to S3 storage services like AWS S3 and MinIO. While OpenStack has its own middleware to accept requests in S3 protocol, herald addresses some issues you will face using that S3 middleware. Currently, herald supports two types of backends(storage providers): S3 and OpenStack Swift. A comprehensive list of herald's features and capabilities are listed below.

## Features

- Multi Backend Compatibility: interacting with multiple storage backends using a single protocol. You can use the S3 protocol to communicate with storage services that don't necessarily support an S3 protocol natively. Herald supports S3 and OpenStack Swift Storage backends as of right now.
- Kubernetes Native Authentication: herald supports authentication using a service account provisioned by the Kubernetes server. You can register services in your cluster that can access herald and the resources managed by herald to allow a robust authentication pipeline easy to manage.
- Mirroring: a multi-backend commit is another handy feature in herald that allows you to mirror any operations you make to your storage services through herald. You can have a primary storage configured with replicas. The primary and replicas will be in sync and during times of unavailability, herald will use the replicas to fetch data. For write operations, after the operation has been completed, it will be mirrored to a replica storage. The mirroring is done using transactional tasks, stored in a message/task queue, which ensures the replicas are in sync. For read operations, the operation will be forwarded to replica storages if the primary is unavailable. The mirroring operations are done using web workers to avoid the impact on performance.
- IaC Support: Herald supports IaC tech stacks that use the S3 protocol to provision resources such as Terraform and OpenTofu.

##  Project Structure

```sh
└── herald/
    ├── .github
    │   ├── dependabot.yml
    │   ├── pull_request_template.md
    │   └── workflows
    ├── Dockerfile
    ├── LICENSE.md
    ├── README.md
    ├── benchmarks
    │   ├── bench_saver.ts
    │   ├── result.json
    │   └── sdk
    ├── deno.jsonc
    ├── deno.lock
    ├── docker-compose.yml
    ├── examples
    │   └── simple-bucket-test
    ├── ghjk.ts
    ├── herald-compose.yaml
    ├── herald.yaml
    ├── import_map.json
    ├── src
    │   ├── auth
    │   ├── backends
    │   ├── buckets
    │   ├── config
    │   ├── constants
    │   ├── main.ts
    │   ├── types
    │   ├── utils
    │   └── workers
    ├── tests
    │   ├── iac
    │   ├── mirror
    │   ├── s3
    │   ├── swift
    │   └── utils
    ├── tools
    │   ├── compose
    │   ├── deps.ts
    │   └── s3-comparison
    └── utils
        ├── file.ts
        └── s3.ts
````

---

## Getting Started

### Prerequisites

Before getting started with herald, ensure your runtime environment meets the following requirements:

- **Programming Language:** TypeScript
- **Container Runtime:** Docker

### Development

Install herald using one of the following methods:

**Build from source:**

1. Clone the herald repository:

```sh
❯ git clone https://github.com/expnt/herald
```

2. Navigate to the project directory:

```sh
❯ cd herald
```

3. Install ghjk

[ghjk](https://github.com/metatypedev/ghjk) is a developer environment management tool used to install dependencies required to run herald.

4. Install dependencies

```sh
❯ ghjk p resolve
```

5. Run services needed for herald.

We just spin a minio s3 server and a swift object storage container in docker.

```sh
❯ ghjk dev-compose up all
```

6. Configure herald.yaml

Configuration for the cloud services that herald connects with are defined here. Other configs such as the port it runs on, temporary dir for tests is also defined here. The object storage for a task store is also defined here. A serialized task store is saved in the specified storage service where durable tasks for mirroring tasks are stored. Service account names are also configured for jwk based authentication. This is a sample configuration file.

```yaml
port: 8000
temp_dir: "./tmp"
backends:
  minio_s3:
    protocol: s3
  openstack_swift:
    protocol: swift
  exoscale_s3:
    protocol: s3

task_store_backend:
  endpoint: "http://localhost:9000"
  region: local
  forcePathStyle: true
  bucket: task-store
  credentials:
    accessKeyId: minio
    secretAccessKey: password

service_accounts:
  - name: "system:serviceaccount:dev-s3-herald:default"
    buckets:
      - s3-test
      - s3-mirror-test
      - swift-mirror-test
      - iac-s3
  - name: "system:serviceaccount:stg-datacycle:datacycle-app-backend-sa"
    buckets:
      - s3-test
      - s3-mirror-test
      - iac-s3

buckets:
  s3-test:
    backend: minio_s3
    config:
      endpoint: "http://localhost:9000"
      region: local
      forcePathStyle: true
      bucket: s3-test
      credentials:
        accessKeyId: minio
        secretAccessKey: password

replicas:
  - name: replica-0
    backend: minio_s3
    config:
      endpoint: "http://localhost:9090"
      region: local
      forcePathStyle: true
      bucket: s3-test
      credentials:
        accessKeyId: minio
        secretAccessKey: password
```


7. Run herald

```sh
❯ deno run src/main.ts
```

### herald.yaml config file

This configuration YAML file is used to set up and manage the Herald service, which interacts with various storage backends and service accounts. Below is a detailed description of the key sections in the file:

- **port**: Specifies the port number (8000) on which herald will run.
- **temp_dir**: Defines the temporary directory (`./tmp`) used by the service.
- **backends**: Lists the supported storage backends, including `minio_s3`, `openstack_swift`, and `exoscale_s3`, each with its respective protocol.
- **task_store_backend**: Configures the backend for storing tasks, including the endpoint, region, path style, bucket name, and credentials (access key ID and secret access key).
- **service_accounts**: Defines the service accounts with access to specific buckets. Each service account has a name and a list of accessible buckets.
- **buckets**: Specifies the configuration for individual buckets, including the backend type, endpoint, region, path style, bucket name, and credentials.
- **replicas**: Configures replicas for redundancy and load balancing. Each replica has a name, backend type, and configuration similar to the buckets section.

This configuration file allows for flexible and secure management of storage resources and service accounts, ensuring that the Herald service can interact with multiple storage backends and maintain high availability through replicas.

### Environment Variables
| **Name**                   | **Default**  | **Description**  |
|----------------------------|------------------------------|-------------------------------|
| **debug**                  | —                                                                      | Boolean string that enables or disables debug mode.                                            |
| **log_level**              | (optional)                                                             | Logging level; possible values: `NOTSET`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL`.        |
| **env**                    | `DEV`                                                                  | Environment in which the application runs (`DEV` or `PROD`).                                  |
| **k8s_api**                | `https://kubernetes.default.svc`                                      | URL for the Kubernetes API.                                                                   |
| **cert_path**              | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`                 | File path to the Kubernetes service account CA certificate.                                   |
| **config_file_path**       | herald.yaml | Path to the Herald configuration file.                                                        |
| **service_account_token_path** | `/var/run/secrets/kubernetes.io/serviceaccount/token`              | File path to the Kubernetes service account token.                                            |
| **version**                | `0.1`                                                                  | Application version.                                                                          |
| **sentry_dsn**             | (optional)                                                             | DSN for Sentry, used for error tracking.                                                      |
| **sentry_sample_rate**     | `1`                                                                    | Sampling rate for Sentry events (numeric, 0 to 1).                                            |
| **sentry_traces_sample_rate** | `1`                                                                 | Sampling rate for Sentry traces (numeric, 0 to 1).                                            |

### Run using docker

Pull the image first

```sh
❯ docker pull ghcr.io/expnt/herald:latest
```

Run herald using the following command:
**Using `docker`** &nbsp; [<img align="center" src="https://img.shields.io/badge/Docker-2CA5E0.svg?style={badge_style}&logo=docker&logoColor=white" />](https://www.docker.com/)

```sh
❯ docker run -it expnt/herald:latest
```

### Testing

To run full tests,

```sh
❯ deno test -A tests
```

---

## Project Roadmap

- [x] **`Task 1`**: Mirroring
- [ ] **`Task 2`**: Event Notification.
- [ ] **`Task 3`**: Advanced Cache Policy

---

## Contributing

- **💬 [Join the Discussions](https://github.com/expnt/herald/discussions)**: Share your insights, provide feedback, or ask questions.
- **🐛 [Report Issues](https://github.com/expnt/herald/issues)**: Submit bugs found or log feature requests for the `herald` project.
- **💡 [Submit Pull Requests](https://github.com/expnt/herald/blob/main/CONTRIBUTING.md)**: Review open PRs, and submit your own PRs.

<details closed>
<summary>Contributing Guidelines</summary>

1. **Fork the Repository**: Start by forking the project repository to your github account.
2. **Clone Locally**: Clone the forked repository to your local machine using a git client.
   ```sh
   git clone https://github.com/expnt/herald
   ```
3. **Create a New Branch**: Always work on a new branch, giving it a descriptive name.
   ```sh
   git checkout -b new-feature-x
   ```
4. **Make Your Changes**: Develop and test your changes locally.
5. **Commit Your Changes**: Commit with a clear message describing your updates.
   ```sh
   git commit -m 'Implemented new feature x.'
   ```
6. **Push to github**: Push the changes to your forked repository.
   ```sh
   git push origin new-feature-x
   ```
7. **Submit a Pull Request**: Create a PR against the original project repository. Clearly describe the changes and their motivations.
8. **Review**: Once your PR is reviewed and approved, it will be merged into the main branch. Congratulations on your contribution!
</details>

<details closed>
<summary>Contributor Graph</summary>
<br>
<p align="left">
   <a href="https://github.com{/expnt/herald/}graphs/contributors">
      <img src="https://contrib.rocks/image?repo=expnt/herald">
   </a>
</p>
</details>

---

## Acknowledgments

- List any resources, contributors, inspiration, etc. here.

---
