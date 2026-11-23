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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const CI_COMMON = path.join(SCRIPT_DIR, 'ci-common.sh');

function runBash(snippet, extraEnv = {}) {
  return execFileSync(
    'bash',
    ['-c', `source "${CI_COMMON}" && ${snippet}`],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    }
  );
}

describe('scripts/ci-common.sh authorization & security helpers', () => {
  it('accepts CODEOWNERS maintainers and rejects bots or unknown users', () => {
    runBash('is_authorized_maintainer "dilipkumar2k6" "NONE"');
    runBash('is_authorized_maintainer "sarathps93" "NONE"');
    runBash('is_authorized_maintainer "cmuuss" "NONE"');

    assert.throws(() => runBash('is_authorized_maintainer "renovate-bot" "COLLABORATOR"'));
    assert.throws(() => runBash('is_authorized_maintainer "dependabot[bot]" "CONTRIBUTOR"'));
    assert.throws(() => runBash('is_authorized_maintainer "random-external-user" "NONE"'));
  });

  it('masks multi-line secret values line-by-line in GitHub Actions mode', () => {
    const out = runBash(
      'mask_secret_value "{\n  \\"private_key_id\\": \\"secret-id-1\\",\n  \\"private_key\\": \\"line-a\\"\n}"',
      { GITHUB_ACTIONS: 'true' }
    );
    assert.match(out, /::add-mask::"private_key_id": "secret-id-1",/);
    assert.match(out, /::add-mask::"private_key": "line-a"/);
    assert.doesNotMatch(out, /::add-mask::\{$/m);
  });
});
