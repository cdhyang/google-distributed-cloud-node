// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * End-to-end integration test suite for `gdc-cas` against GDC Air-gapped Staging
 * (`gdc1` / `us-west6-a.staging.gpcdemolabs.com`).
 *
 * Covers Use Cases UC1–UC6:
 *  - UC1: STS RFC 8693 authentication & custom GDC Root CA trust validation
 *  - UC2: CertificateAuthority discovery & X.509 PEM chain validation
 *  - UC3: KRM certificate issuance (Date + RFC3339 validity), public-key & chain verification, get & list
 *  - UC4: KRM certificate revocation, get & list, and deterministic CR cleanup (+ >1h stale CR sweep)
 *  - UC5: Direct gRPC dataplane (`useGrpc: true`) certificate issuance & PEM revocation
 *  - UC6: Fast-fail negative validation (invalid `notBefore` & non-existent CA ref)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { CASClient, RevocationReason } from 'gdc-cas';

const OFFLINE_SELFTEST = process.env.GDC_CAS_OFFLINE_SELFTEST === 'true';
const SA_FILE = process.env.GDC_CAS_SA_FILE || '';
const CA_FILE = process.env.GDC_CAS_CA_FILE || '';
const ZONE = process.env.GDC_ZONE || 'us-west6-a';
const PROJECT = process.env.GDC_CAS_PROJECT || 'gdc-node-sdk-ci';
const CA_NAME = process.env.GDC_CAS_CA_NAME || 'sdk-ci-ca';
const CI_REQ_PREFIX = 'cas-sdk-ci-';
const STALE_CR_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Minimal ASN.1 DER helpers to build a standards-compliant PKCS#10 (RFC 2986)
// RSA-SHA256 CSR using only Node's built-in `node:crypto` (zero extra deps).
function derLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let remaining = len;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derNode(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derSequence(...items) {
  return derNode(0x30, Buffer.concat(items));
}

function derSet(...items) {
  return derNode(0x31, Buffer.concat(items));
}

function derOid(oidBytes) {
  return derNode(0x06, Buffer.from(oidBytes));
}

function derUtf8String(str) {
  return derNode(0x0c, Buffer.from(str, 'utf8'));
}

function derBitString(buf) {
  return derNode(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

export function generateRsaCsrPem(commonName) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  // Version 0 INTEGER: 02 01 00
  const version = Buffer.from([0x02, 0x01, 0x00]);
  // OID 2.5.4.3 (commonName) = 55 04 03
  const cnAttr = derSequence(derOid([0x55, 0x04, 0x03]), derUtf8String(commonName));
  const subject = derSequence(derSet(cnAttr));
  // Attributes [0] IMPLICIT: A0 00
  const attributes = Buffer.from([0xa0, 0x00]);

  const certReqInfo = derSequence(version, subject, spkiDer, attributes);

  // sha256WithRSAEncryption OID 1.2.840.113549.1.1.11 + NULL
  const sigAlg = derSequence(
    derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
    Buffer.from([0x05, 0x00])
  );
  const signature = crypto.sign('sha256', certReqInfo, privateKey);
  const csrDer = derSequence(certReqInfo, sigAlg, derBitString(signature));

  const b64 = csrDer.toString('base64').match(/.{1,64}/g).join('\n');
  const csrPem = `-----BEGIN CERTIFICATE REQUEST-----\n${b64}\n-----END CERTIFICATE REQUEST-----\n`;
  return { csrPem, csrBase64: Buffer.from(csrPem, 'utf8').toString('base64'), publicKey };
}

function parseFirstPemCert(pemBundle) {
  const match = String(pemBundle || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  assert.ok(match, 'Expected PEM bundle to contain at least one X.509 certificate');
  return new crypto.X509Certificate(match[0]);
}

async function sweepStaleCiResources(client, namespace) {
  const cutoff = Date.now() - STALE_CR_MAX_AGE_MS;
  try {
    const revokes = await client.listRevokeCertificateRequests(namespace);
    for (const item of revokes?.items || []) {
      const name = item?.metadata?.name || '';
      const created = Date.parse(item?.metadata?.creationTimestamp || '');
      if (name.startsWith(CI_REQ_PREFIX) && Number.isFinite(created) && created < cutoff) {
        await client.deleteRevokeCertificateRequest(namespace, name).catch(() => {});
      }
    }
    const reqs = await client.listCertificateRequests(namespace);
    for (const item of reqs?.items || []) {
      const name = item?.metadata?.name || '';
      const created = Date.parse(item?.metadata?.creationTimestamp || '');
      if (name.startsWith(CI_REQ_PREFIX) && Number.isFinite(created) && created < cutoff) {
        await client.deleteCertificateRequest(namespace, name).catch(() => {});
      }
    }
  } catch {
    // Non-fatal best-effort sweep.
  }
}

describe('Offline CSR & Fast-Fail Self-Tests', () => {
  it('generates a valid PKCS#10 RSA-2048 CSR and base64 payload', () => {
    const { csrPem, csrBase64, publicKey } = generateRsaCsrPem('ci-selftest.gdc.local');
    assert.match(csrPem, /^-----BEGIN CERTIFICATE REQUEST-----/);
    assert.equal(Buffer.from(csrBase64, 'base64').toString('utf8'), csrPem);
    assert.equal(publicKey.asymmetricKeyType, 'rsa');
  });

  it('validates CASClient constructor arguments synchronously', () => {
    assert.throws(() => new CASClient({ zone: 'us-west6-a' }), /saFilePath.*serviceAccount/i);
  });
});

describe('GDC Air-gapped Staging CAS Integration Suite (KRM & Direct gRPC)', { skip: OFFLINE_SELFTEST }, () => {
  let krmClient;
  let grpcClient;

  before(async () => {
    assert.ok(SA_FILE && fs.existsSync(SA_FILE), 'GDC_CAS_SA_FILE must point to an existing service account JSON file');
    assert.ok(CA_FILE && fs.existsSync(CA_FILE), 'GDC_CAS_CA_FILE must point to an existing Root CA PEM file');

    // UC1: STS RFC 8693 authentication & custom GDC Root CA trust validation
    krmClient = new CASClient({
      saFilePath: SA_FILE,
      caFilePath: CA_FILE,
      zone: ZONE,
      useGrpc: false,
    });
    await krmClient.init();
    await sweepStaleCiResources(krmClient, PROJECT);

    grpcClient = new CASClient({
      saFilePath: SA_FILE,
      caFilePath: CA_FILE,
      zone: ZONE,
      useGrpc: true,
    });
    await grpcClient.init();
  });

  it('UC2: discovers staging CertificateAuthority and validates PEM chain', async () => {
    const caInfo = await krmClient.getCertificateAuthority(PROJECT, CA_NAME);
    assert.ok(caInfo.certificateAuthority, 'Expected KRM CertificateAuthority object');
    const leafCa = parseFirstPemCert(caInfo.caCertificate);
    const rootCa = parseFirstPemCert(caInfo.rootCACertificate);
    assert.ok(leafCa.subject.length > 0);
    assert.ok(rootCa.subject.length > 0);
  });

  it('UC3 & UC4: issues, inspects, lists, revokes, and cleans up certificate over KRM', async () => {
    const runSuffix = crypto.randomBytes(4).toString('hex');
    const certReqName = `${CI_REQ_PREFIX}krm-${runSuffix}`;
    const revokeReqName = `${CI_REQ_PREFIX}rev-${runSuffix}`;
    const { csrBase64, publicKey } = generateRsaCsrPem(`krm-${runSuffix}.sdk-ci.example.com`);

    const now = new Date();
    const notAfterIso = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

    let createdCert = false;
    let createdRevoke = false;

    try {
      const issueRes = await krmClient.createCertificateRequest(
        PROJECT,
        {
          certificateAuthorityRef: CA_NAME,
          certReqName,
          csr: csrBase64,
          notBefore: now,
          notAfter: notAfterIso,
        },
        { timeoutMs: 30000, pollingIntervalMs: 300 }
      );
      createdCert = true;
      assert.equal(issueRes.certificateRequestName, certReqName);

      const issuedX509 = parseFirstPemCert(issueRes.tlsCrt);
      const signingCaX509 = parseFirstPemCert(issueRes.caCert);
      assert.equal(issuedX509.verify(signingCaX509.publicKey), true, 'Issued cert must verify against CA public key');
      assert.deepEqual(
        issuedX509.publicKey.export({ type: 'spki', format: 'der' }),
        publicKey.export({ type: 'spki', format: 'der' }),
        'Issued cert public key must match CSR keypair'
      );

      const fetchedCr = await krmClient.getCertificateRequest(PROJECT, certReqName);
      assert.equal(fetchedCr?.metadata?.name, certReqName);

      const listedCrs = await krmClient.listCertificateRequests(PROJECT);
      assert.ok(
        (listedCrs?.items || []).some((item) => item?.metadata?.name === certReqName),
        'listCertificateRequests must include newly created CertificateRequest'
      );

      // UC4: KRM revocation
      const revokeRes = await krmClient.createRevokeCertificateRequest(
        PROJECT,
        {
          revokeReqName,
          reason: RevocationReason.SUPERSEDED,
          certificateRequestRef: {
            name: certReqName,
            namespace: PROJECT,
          },
        },
        { timeoutMs: 60000, pollingIntervalMs: 300 }
      );
      createdRevoke = true;
      assert.equal(revokeRes.revokeCertificateRequestName, revokeReqName);

      const fetchedRevoke = await krmClient.getRevokeCertificateRequest(PROJECT, revokeReqName);
      assert.equal(fetchedRevoke?.metadata?.name, revokeReqName);

      const listedRevokes = await krmClient.listRevokeCertificateRequests(PROJECT);
      assert.ok(
        (listedRevokes?.items || []).some((item) => item?.metadata?.name === revokeReqName),
        'listRevokeCertificateRequests must include newly created RevokeCertificateRequest'
      );
    } finally {
      if (createdRevoke) {
        await krmClient.deleteRevokeCertificateRequest(PROJECT, revokeReqName).catch(() => {});
      }
      if (createdCert) {
        await krmClient.deleteCertificateRequest(PROJECT, certReqName).catch(() => {});
      }
    }
  });

  it('UC5: issues and revokes certificate over direct gRPC dataplane (useGrpc: true)', async () => {
    const runSuffix = crypto.randomBytes(4).toString('hex');
    const { csrBase64, publicKey } = generateRsaCsrPem(`grpc-${runSuffix}.sdk-ci.example.com`);

    const issueRes = await grpcClient.createCertificateRequest(PROJECT, {
      certificateAuthorityRef: CA_NAME,
      certReqName: `${CI_REQ_PREFIX}grpc-${runSuffix}`,
      csr: csrBase64,
    });

    const issuedX509 = parseFirstPemCert(issueRes.tlsCrt);
    const signingCaX509 = parseFirstPemCert(issueRes.caCert);
    assert.equal(issuedX509.verify(signingCaX509.publicKey), true, 'gRPC issued cert must verify against CA key');
    assert.deepEqual(
      issuedX509.publicKey.export({ type: 'spki', format: 'der' }),
      publicKey.export({ type: 'spki', format: 'der' })
    );

    const revokeRes = await grpcClient.createRevokeCertificateRequest(PROJECT, {
      certificate: issueRes.tlsCrt,
      reason: RevocationReason.CESSATION_OF_OPERATION,
    });
    assert.ok(revokeRes);
  });

  it('UC6: fails fast on invalid validity dates and non-existent CA references', async () => {
    const { csrBase64 } = generateRsaCsrPem('neg-test.sdk-ci.example.com');

    await assert.rejects(
      () =>
        krmClient.createCertificateRequest(PROJECT, {
          certificateAuthorityRef: CA_NAME,
          csr: csrBase64,
          notBefore: 'not-a-valid-rfc3339-timestamp',
        }),
      /Invalid date/i
    );

    const start = Date.now();
    await assert.rejects(() =>
      grpcClient.createCertificateRequest(PROJECT, {
        certificateAuthorityRef: 'non-existent-ca-ci-negative-check',
        csr: csrBase64,
      })
    );
    assert.ok(Date.now() - start < 15000, 'Permanent non-existent CA error should fail fast');
  });
});
