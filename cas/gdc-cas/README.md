# Google Distributed Cloud air-gapped CAS Node.js Client

This package provides a Node.js client to interact with the Google Distributed Cloud air-gapped (GDC) Certificate Authority Service (CAS).

## Installation

```sh
npm install gdc-cas
```

## Supported GDC Air-gapped Versions

`gdc-cas` follows independent [Semantic Versioning](https://semver.org/) decoupled from GDC Air-gapped platform release numbers:

| `gdc-cas` Version | Node.js Runtime | Supported GDC Air-gapped Releases | Notes |
| :--- | :--- | :--- | :--- |
| `0.1.x` | `>= 20.0.0` (LTS) | `1.14`, `1.15`, `1.16+` | `certificateTemplate`, `subjectOverride`, and direct gRPC dataplane (`useGrpc: true`) require GDC `1.15+`. |

## Prerequisites
1. Create a [Project](https://cloud.google.com/distributed-cloud/hosted/docs/1.14-next/gdch/platform/pa-user/create-a-project) in your GDC cluster.
2. Follow the [Manage service accounts](https://cloud.google.com/distributed-cloud/hosted/docs/1.14-next/gdch/application/ao-user/iam/service-identities) steps to create a service account for your project:
    * Assign the `certificate-authority-service-admin` role to your service account.
    * Generate a key pair for your service account and store the private key as a JSON file. This JSON file will be used by the CAS client to authenticate with GDC.
3. Follow the [CAS user guide](https://cloud.google.com/distributed-cloud/hosted/docs/1.14-next/gdch/application/ao-user/ca-service/cas-overview) to create Certificate Authorities(CAs) for your project. The CAs will be referenced by the CAS client when requesting certificates.
4. [Fetch GDC trust bundles](https://cloud.google.com/distributed-cloud/hosted/docs/1.14-next/gdch/platform/pa-user/pki/fetch-trust-bundles) for `trust-store-global-root-ext`. The CAS client will need the trust bundle to connect to the GDC clusters.


## Usage
### Initialization
Provide the following configuration options to initialize the client:
```js
import { CASClient } from 'gdc-cas';

const clientConfig = {
    saFilePath: '/path/to/sa.json', // File path for the service account private key JSON file.
    caFilePath: '/path/to/ca.crt', // File path for the GDC trust store.
    zone: 'us-west6-a', // GDC zone name.
};

// Create and initialize the CASClient
const casClient = new CASClient(clientConfig);
await casClient.init();
```

### gRPC Mode (Bypass KRM)
By default, the client uses the Kubernetes API to manage certificate requests (KRM mode).
If you want to use the gRPC mode, initialize the client with `useGrpc: true`. This bypasses the Kubernetes API server and makes direct gRPC calls to the CAS proxy.

```js
const clientConfig = {
    saFilePath: '/path/to/sa.json',
    caFilePath: '/path/to/ca.crt',
    zone: 'us-west6-a',
    useGrpc: true, // Enable direct gRPC calls
    // casProxyUrl: 'https://cas.org.zone.domain.com' // Optional: Derived from token_uri if not specified
};

const casClient = new CASClient(clientConfig);
await casClient.init();
```

> [!NOTE]
> In gRPC mode, only `createCertificateRequest` and `createRevokeCertificateRequest` are supported. Other KRM operations (`getCertificateRequest`, `listCertificateRequests`, `deleteCertificateRequest`, `getCertificateAuthority`) are not supported over gRPC.

#### Certificate Revocation over gRPC

To request certificate revocation over gRPC:

```js
const revokeParams = {
  certificate: tlsCrtPemString, // The PEM-encoded certificate string to revoke
  reason: 'KEY_COMPROMISE',      // The reason for revocation (RevocationReason enum or string)
};

try {
  const revokeResult = await casClient.createRevokeCertificateRequest(project, revokeParams);
  console.log('Successfully revoked certificate. Reason:', revokeResult.reason);
} catch (error) {
  console.error('Revocation failed:', error.message);
}
```

#### Certificate Revocation over KRM

To request certificate revocation using KRM:

```js
const revokeParams = {
  certificateRequestRef: {
    name: 'original-certificate-request-name', // Name of the original CertificateRequest
    namespace: project,
  },
  reason: 'KEY_COMPROMISE',                     // The reason for revocation (RevocationReason enum or string)
};

try {
  const revokeResult = await casClient.createRevokeCertificateRequest(project, revokeParams, {
    timeoutMs: 15000,
    pollingIntervalMs: 200,
  });
  console.log('Successfully created RevokeCertificateRequest CR. Name:', revokeResult.revokeCertificateRequestName);
} catch (error) {
  console.error('Revocation failed:', error.message);
}
```

### Certificate Requests and Revocation Management
The client supports the following methods to manage certificate requests and revocation:

* `createCertificateRequest`
* `createRevokeCertificateRequest`
* `getRevokeCertificateRequest`
* `deleteRevokeCertificateRequest`
* `listRevokeCertificateRequests`
* `getCertificateRequest`
* `listCertificateRequests`
* `deleteCertificateRequest`
* `getCertificateAuthority`


---

## Local Development & Verification

### 1. Updating the Protocol Buffer

If you modify `proto/cas.proto` to add new endpoints, fields, or services, recompile the static JSON descriptor so the gRPC client can serialize payloads at runtime:

```bash
cd ./cas/gdc-cas
npm run build:proto
```
*Note: Commit the updated `proto/cas-json.js` file alongside your `.proto` changes (verified automatically in CI).*

### 2. Running Unit, Type & Package Smoke Tests

```bash
cd ./cas/gdc-cas
npm ci
npm run check:types
npm test
```

### 3. Releases & Publishing

Official releases of `gdc-cas` to [npmjs.com](https://www.npmjs.com/package/gdc-cas) are published exclusively through the repository's automated GitHub Actions release pipeline and Google OSS Exit Gate after passing GDC Air-gapped Staging integration verification. Do not run `npm publish` manually from a local workstation.
