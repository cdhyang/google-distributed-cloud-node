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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';

import { getStsToken } from '../sts-auth.js';

function createEphemeralEcKeyPair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/authenticate` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('getStsToken', () => {
  it('validates required inputs', async () => {
    await assert.rejects(() => getStsToken(null, 'https://aud.example'), /saConfig.*required/);
    await assert.rejects(() => getStsToken({}, ''), /targetStsAudience.*required/);
    await assert.rejects(
      () => getStsToken({ name: 'sa' }, 'https://aud.example'),
      /Invalid service account configuration/
    );
  });

  it('signs an ES256 JWT and exchanges it for an STS access token', async () => {
    const { privateKey, publicKey } = createEphemeralEcKeyPair();
    let capturedBody = null;

    const { server, url } = await startMockServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'sts-access-token-123',
          token_type: 'Bearer',
          expires_in: 3600,
        }));
      });
    });

    try {
      const saConfig = {
        name: 'test-sa',
        project: 'test-project',
        privateKeyId: 'key-id-42',
        privateKey,
        tokenUri: url,
      };
      const targetAudience = 'https://management-kube.apiserver.gdc1.us-west6-a.example.com';
      const token = await getStsToken(saConfig, targetAudience);

      assert.equal(token.accessToken, 'sts-access-token-123');
      assert.equal(token.tokenType, 'Bearer');
      assert.ok(token.expiry instanceof Date);
      assert.ok(token.expiry.getTime() > Date.now() + 3500 * 1000);

      assert.equal(capturedBody.grant_type, 'urn:ietf:params:oauth:token-type:token-exchange');
      assert.equal(capturedBody.audience, targetAudience);
      assert.equal(capturedBody.requested_token_type, 'urn:ietf:params:oauth:token-type:access_token');
      assert.equal(capturedBody.subject_token_type, 'urn:k8s:params:oauth:token-type:serviceaccount');

      const decoded = jwt.decode(capturedBody.subject_token, { complete: true });
      assert.equal(decoded.header.alg, 'ES256');
      assert.equal(decoded.header.kid, 'key-id-42');
      assert.equal(decoded.header.typ, 'JWT');

      const verified = jwt.verify(capturedBody.subject_token, publicKey, { algorithms: ['ES256'] });
      assert.equal(verified.iss, 'system:serviceaccount:test-project:test-sa');
      assert.equal(verified.sub, 'system:serviceaccount:test-project:test-sa');
      assert.equal(verified.aud, url);
      assert.equal(verified.nbf, verified.iat);
      assert.equal(verified.exp - verified.iat, 3600);
      assert.match(
        verified.jti,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );

      const secondToken = await getStsToken(saConfig, targetAudience);
      assert.equal(secondToken.accessToken, 'sts-access-token-123');
      const secondVerified = jwt.verify(capturedBody.subject_token, publicKey, { algorithms: ['ES256'] });
      assert.notEqual(secondVerified.jti, verified.jti);
    } finally {
      await stopServer(server);
    }
  });

  it('retries transient HTTP 503 responses and succeeds', async () => {
    const { privateKey } = createEphemeralEcKeyPair();
    let attempts = 0;

    const { server, url } = await startMockServer((_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'temporarily unavailable' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'sts-after-retry',
        expires_in: 600,
      }));
    });

    try {
      const token = await getStsToken(
        {
          name: 'test-sa',
          project: 'test-project',
          privateKeyId: 'key-id-retry',
          privateKey,
          tokenUri: url,
        },
        'https://aud.example'
      );
      assert.equal(attempts, 2);
      assert.equal(token.accessToken, 'sts-after-retry');
      assert.equal(token.tokenType, 'Bearer');
    } finally {
      await stopServer(server);
    }
  });
});
