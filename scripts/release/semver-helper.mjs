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
 * SemVer resolution, post-release version bump calculation, and GitHub Pages
 * `runs.json` ledger updater for multi-package Node.js SDK releases.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PACKAGE_REGISTRY = {
  'gdc-cas': {
    dir: 'cas/gdc-cas',
    tagPrefix: 'gdc-cas-v',
  },
};

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemVer(version) {
  const match = String(version || '').trim().match(SEMVER_RE);
  if (!match) {
    throw new Error(`Invalid SemVer 2.0 version '${version}'. Expected X.Y.Z or X.Y.Z-prerelease.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
  };
}

export function computeNextVersion(currentVersion, bumpOp) {
  const parsed = parseSemVer(currentVersion);
  switch (bumpOp) {
    case 'noop':
      return currentVersion;
    case 'bump-patch':
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
    case 'bump-minor':
      return `${parsed.major}.${parsed.minor + 1}.0`;
    case 'bump-major':
      return `${parsed.major + 1}.0.0`;
    case 'bump-prerelease': {
      if (!parsed.prerelease) {
        return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-alpha.0`;
      }
      const parts = parsed.prerelease.split('.');
      const last = parts[parts.length - 1];
      if (/^\d+$/.test(last)) {
        parts[parts.length - 1] = String(Number(last) + 1);
        return `${parsed.major}.${parsed.minor}.${parsed.patch}-${parts.join('.')}`;
      }
      return `${parsed.major}.${parsed.minor}.${parsed.patch}-${parsed.prerelease}.1`;
    }
    default:
      throw new Error(`Unsupported next_version operation '${bumpOp}'.`);
  }
}

export function resolveReleasePlan({ packageName, releaseMode, repoRoot = process.cwd() }) {
  const pkgMeta = PACKAGE_REGISTRY[packageName];
  if (!pkgMeta) {
    throw new Error(`Unknown package '${packageName}'. Supported: ${Object.keys(PACKAGE_REGISTRY).join(', ')}`);
  }
  if (!['canary', 'prerelease', 'release'].includes(releaseMode)) {
    throw new Error(`Invalid release_mode '${releaseMode}'. Expected canary, prerelease, or release.`);
  }

  const pkgJsonPath = path.join(repoRoot, pkgMeta.dir, 'package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const version = String(pkgJson.version || '').trim();
  const parsed = parseSemVer(version);

  if (releaseMode === 'release' && parsed.prerelease) {
    throw new Error(
      `Official release mode requires a clean X.Y.Z version in ${pkgMeta.dir}/package.json (found '${version}').`
    );
  }
  if (releaseMode === 'prerelease' && !parsed.prerelease) {
    throw new Error(
      `Prerelease mode requires a pre-release suffix such as X.Y.Z-alpha.N in ${pkgMeta.dir}/package.json (found '${version}').`
    );
  }

  const gitTag = releaseMode === 'canary' ? '-' : `${pkgMeta.tagPrefix}${version}`;
  const npmDistTag = releaseMode === 'release' ? 'latest' : (releaseMode === 'prerelease' ? 'alpha' : '');

  let lastTag = '';
  try {
    lastTag = execFileSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', `${pkgMeta.tagPrefix}*`],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    lastTag = '';
  }

  let hasChanges = true;
  if (lastTag) {
    try {
      execFileSync(
        'git',
        ['diff', '--quiet', `${lastTag}..HEAD`, '--', pkgMeta.dir],
        { cwd: repoRoot }
      );
      hasChanges = false;
    } catch {
      hasChanges = true;
    }
  }

  return {
    packageName,
    packageDir: pkgMeta.dir,
    version,
    gitTag,
    npmDistTag,
    lastTag,
    needsPublish: releaseMode !== 'canary' && hasChanges,
  };
}

export function appendDashboardRun(runsFilePath, newEntry, maxEntries = 200) {
  let existing = [];
  if (fs.existsSync(runsFilePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(runsFilePath, 'utf8'));
      if (Array.isArray(raw)) existing = raw;
    } catch {
      existing = [];
    }
  }
  const filtered = existing.filter((r) => String(r.runId) !== String(newEntry.runId));
  const updated = [newEntry, ...filtered].slice(0, maxEntries);
  fs.mkdirSync(path.dirname(runsFilePath), { recursive: true });
  fs.writeFileSync(runsFilePath, JSON.stringify(updated, null, 2) + '\n');
  return updated;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const cmd = process.argv[2];
  if (cmd === 'resolve') {
    const plan = resolveReleasePlan({
      packageName: process.env.PACKAGE_NAME || 'gdc-cas',
      releaseMode: process.env.RELEASE_MODE || 'canary',
    });
    if (process.env.GITHUB_OUTPUT) {
      const lines = [
        `package_name=${plan.packageName}`,
        `package_dir=${plan.packageDir}`,
        `version=${plan.version}`,
        `git_tag=${plan.gitTag}`,
        `npm_dist_tag=${plan.npmDistTag}`,
        `needs_publish=${plan.needsPublish}`,
      ];
      fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
    }
    console.log(JSON.stringify(plan, null, 2));
  } else if (cmd === 'bump') {
    const nextVer = computeNextVersion(process.env.CURRENT_VERSION || '', process.env.NEXT_VERSION_OP || 'noop');
    console.log(nextVer);
  } else if (cmd === 'append-run') {
    const targetFile = process.argv[3];
    const entry = {
      runId: process.env.RUN_ID || '',
      runNumber: process.env.RUN_NUMBER || '',
      timestamp: new Date().toISOString(),
      package: process.env.PACKAGE_NAME || 'gdc-cas',
      releaseMode: process.env.RELEASE_MODE || 'canary',
      trigger: process.env.TRIGGER_EVENT || 'manual',
      actor: process.env.ACTOR || '',
      status: process.env.OVERALL_STATUS || 'failure',
      version: process.env.PACKAGE_VERSION || '-',
      tag: process.env.GIT_TAG || '-',
      commitSha: process.env.COMMIT_SHA || '',
      duration: process.env.DURATION || 'N/A',
      runUrl: process.env.RUN_URL || '',
      stages: {
        authorize: process.env.STAGE_AUTHORIZE || 'skipped',
        staging: process.env.STAGE_STAGING || 'skipped',
        publish: process.env.STAGE_PUBLISH || 'skipped',
      },
    };
    appendDashboardRun(targetFile, entry);
  } else {
    console.error(`Unknown subcommand '${cmd}'. Expected resolve, bump, or append-run.`);
    process.exit(1);
  }
}
