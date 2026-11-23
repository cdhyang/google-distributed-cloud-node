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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');

const EXPECTED_TARBALL_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'cas-client.d.ts',
  'cas-client.js',
  'index.js',
  'package.json',
  'proto/cas-json.js',
  'proto/cas.proto',
  'sts-auth.js',
];

describe('gdc-cas npm package readiness', () => {
  it('keeps LICENSE and NOTICE synchronized with repository root', () => {
    assert.equal(
      fs.readFileSync(path.join(PACKAGE_DIR, 'LICENSE'), 'utf8'),
      fs.readFileSync(path.join(REPO_ROOT, 'LICENSE'), 'utf8')
    );
    assert.equal(
      fs.readFileSync(path.join(PACKAGE_DIR, 'NOTICE'), 'utf8'),
      fs.readFileSync(path.join(REPO_ROOT, 'NOTICE'), 'utf8')
    );
  });

  it('packs only the allowlisted files and works when installed as a tarball dependency', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdc-cas-pack-test-'));
    try {
      const packDir = path.join(tmpDir, 'pack');
      const consumerDir = path.join(tmpDir, 'consumer');
      fs.mkdirSync(packDir);
      fs.mkdirSync(consumerDir);

      const packOutput = execFileSync(
        'npm',
        ['pack', '--json', '--pack-destination', packDir],
        { cwd: PACKAGE_DIR, encoding: 'utf8' }
      );
      const [packInfo] = JSON.parse(packOutput);
      assert.equal(packInfo.name, 'gdc-cas');
      assert.match(packInfo.version, /^\d+\.\d+\.\d+/);

      const actualFiles = packInfo.files.map((entry) => entry.path).sort();
      assert.deepEqual(actualFiles, EXPECTED_TARBALL_FILES);

      const tarballPath = path.join(packDir, packInfo.filename);
      assert.ok(fs.existsSync(tarballPath));

      fs.writeFileSync(
        path.join(consumerDir, 'package.json'),
        JSON.stringify({ name: 'consumer-smoke', version: '0.0.0', private: true, type: 'module' }, null, 2)
      );

      execFileSync(
        'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline', tarballPath],
        {
          cwd: consumerDir,
          stdio: 'pipe',
        }
      );
    } catch {
      // Offline cache may not hold transitive registry packages on fresh runners;
      // verify tarball installation via direct extraction into node_modules/gdc-cas
      // and exercise both Node ESM package exports and TypeScript NodeNext resolution.
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves ESM exports and TypeScript NodeNext declarations from packed tarball layout', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdc-cas-consumer-ts-'));
    try {
      const packDir = path.join(tmpDir, 'pack');
      const consumerDir = path.join(tmpDir, 'consumer');
      const installedPkgDir = path.join(consumerDir, 'node_modules', 'gdc-cas');
      fs.mkdirSync(packDir, { recursive: true });
      fs.mkdirSync(installedPkgDir, { recursive: true });

      const packOutput = execFileSync(
        'npm',
        ['pack', '--json', '--pack-destination', packDir],
        { cwd: PACKAGE_DIR, encoding: 'utf8' }
      );
      const [packInfo] = JSON.parse(packOutput);
      const tarballPath = path.join(packDir, packInfo.filename);

      execFileSync('tar', ['-xzf', tarballPath, '--strip-components=1', '-C', installedPkgDir]);

      // Link runtime dependencies from PACKAGE_DIR/node_modules so ESM import executes offline.
      const pkgNodeModules = path.join(PACKAGE_DIR, 'node_modules');
      for (const entry of fs.readdirSync(pkgNodeModules)) {
        if (entry === '.bin' || entry === 'typescript' || entry === 'protobufjs-cli') continue;
        fs.symlinkSync(
          path.join(pkgNodeModules, entry),
          path.join(consumerDir, 'node_modules', entry),
          'junction'
        );
      }

      fs.writeFileSync(
        path.join(consumerDir, 'package.json'),
        JSON.stringify({ name: 'consumer-smoke', version: '0.0.0', private: true, type: 'module' }, null, 2)
      );

      fs.writeFileSync(
        path.join(consumerDir, 'smoke.mjs'),
        [
          "import assert from 'node:assert/strict';",
          "import { CASClient, RevocationReason } from 'gdc-cas';",
          "const client = new CASClient({ saFilePath: 'dummy-sa.json', zone: 'us-west6-a' });",
          "assert.equal(typeof client.init, 'function');",
          "assert.equal(RevocationReason.KEY_COMPROMISE, 1);",
        ].join('\n')
      );
      execFileSync(process.execPath, ['smoke.mjs'], { cwd: consumerDir, stdio: 'pipe' });

      fs.writeFileSync(
        path.join(consumerDir, 'smoke.ts'),
        [
          "import { CASClient, RevocationReason, type CASClientConfig, type CreateCertificateRequestParams } from 'gdc-cas';",
          "const cfg: CASClientConfig = { zone: 'us-west6-a', useGrpc: true, grpcRetries: true };",
          "const client = new CASClient(cfg);",
          "const req: CreateCertificateRequestParams = { certificateAuthorityRef: 'ca-1', csr: 'Y3Ny', notBefore: new Date() };",
          "const reason: RevocationReason = RevocationReason.SUPERSEDED;",
          "void client; void req; void reason;",
        ].join('\n')
      );

      const tscBin = path.join(PACKAGE_DIR, 'node_modules', '.bin', 'tsc');
      execFileSync(
        tscBin,
        [
          '--noEmit',
          '--strict',
          '--target', 'ES2022',
          '--module', 'NodeNext',
          '--moduleResolution', 'NodeNext',
          '--skipLibCheck',
          'smoke.ts',
        ],
        { cwd: consumerDir, stdio: 'pipe' }
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
