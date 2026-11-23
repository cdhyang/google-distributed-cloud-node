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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseSemVer,
  computeNextVersion,
  resolveReleasePlan,
  appendDashboardRun,
} from './semver-helper.mjs';

describe('semver-helper', () => {
  it('parses valid SemVer strings and rejects malformed versions', () => {
    assert.deepEqual(parseSemVer('0.1.0'), { major: 0, minor: 1, patch: 0, prerelease: '' });
    assert.deepEqual(parseSemVer('0.1.0-alpha.2'), {
      major: 0,
      minor: 1,
      patch: 0,
      prerelease: 'alpha.2',
    });
    assert.throws(() => parseSemVer('v0.1'), /Invalid SemVer/);
  });

  it('computes post-release SemVer bumps accurately', () => {
    assert.equal(computeNextVersion('0.1.0', 'noop'), '0.1.0');
    assert.equal(computeNextVersion('0.1.0', 'bump-patch'), '0.1.1');
    assert.equal(computeNextVersion('0.1.0', 'bump-minor'), '0.2.0');
    assert.equal(computeNextVersion('0.1.0', 'bump-major'), '1.0.0');
    assert.equal(computeNextVersion('0.1.0', 'bump-prerelease'), '0.1.1-alpha.0');
    assert.equal(computeNextVersion('0.1.1-alpha.0', 'bump-prerelease'), '0.1.1-alpha.1');
  });

  it('enforces clean vs prerelease versions per release_mode', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-plan-'));
    try {
      const pkgDir = path.join(tmpRepo, 'cas', 'gdc-cas');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'gdc-cas', version: '0.1.0' }));

      const relPlan = resolveReleasePlan({ packageName: 'gdc-cas', releaseMode: 'release', repoRoot: tmpRepo });
      assert.equal(relPlan.version, '0.1.0');
      assert.equal(relPlan.gitTag, 'gdc-cas-v0.1.0');
      assert.equal(relPlan.npmDistTag, 'latest');
      assert.equal(relPlan.needsPublish, true);

      assert.throws(
        () => resolveReleasePlan({ packageName: 'gdc-cas', releaseMode: 'prerelease', repoRoot: tmpRepo }),
        /Prerelease mode requires a pre-release suffix/
      );
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('deduplicates and prepends runs in runs.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-json-'));
    try {
      const runsFile = path.join(tmpDir, 'runs.json');
      appendDashboardRun(runsFile, { runId: '100', status: 'running' });
      const res = appendDashboardRun(runsFile, { runId: '100', status: 'success' });
      assert.equal(res.length, 1);
      assert.equal(res[0].status, 'success');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
