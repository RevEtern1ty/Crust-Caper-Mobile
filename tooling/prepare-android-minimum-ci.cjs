const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { appendFileSync, lstatSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const sourceShaPattern = /^[0-9a-f]{40}$/;
const workflowPath = '.github/workflows/mobile.yml';
const nonBuildFiles = new Set([
  workflowPath,
  'docs/runbooks/MOBILE_RELEASE.md',
  'tooling/android-emulator-smoke.sh',
  'tooling/ios-connected-ci.sh',
  'tooling/prepare-android-minimum-ci.cjs',
  'tooling/run-android-emulator-ci.sh',
  'tooling/test-android-emulator-smoke.sh',
]);

function readCommand(program, args, failure) {
  try {
    return execFileSync(program, args, {
      encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(failure);
  }
}

function readGitHub(path) {
  const output = readCommand('gh', ['api', '--hostname', 'github.com', path], 'GitHub Actions metadata could not be read.');
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('GitHub Actions returned invalid metadata.');
  }
}

function requireProfile(profile) {
  if (profile !== 'demo' && profile !== 'stage') throw new Error('Use the demo or stage profile.');
}

function checkSource(runId, profile) {
  requireProfile(profile);
  const repo = process.env.GITHUB_REPOSITORY;
  const currentSha = process.env.GITHUB_SHA;
  if (!/^[1-9]\d{0,14}$/.test(runId)) throw new Error('Use a numeric GitHub Actions run ID.');
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !sourceShaPattern.test(currentSha)) {
    throw new Error('Use this check from a GitHub Actions checkout.');
  }
  const checkout = readCommand('git', ['rev-parse', 'HEAD'], 'The current checkout SHA could not be read.').trim();
  const worktree = readCommand('git', ['status', '--porcelain=v1', '--untracked-files=no'], 'The checkout state could not be read.');
  if (checkout !== currentSha || worktree) throw new Error('The workflow requires a clean checkout at GITHUB_SHA.');

  const runPath = `repos/${repo}/actions/runs/${runId}`;
  const run = readGitHub(runPath);
  if (!Number.isSafeInteger(run?.id) || String(run.id) !== runId || run.path !== workflowPath
      || run.status !== 'completed' || run.conclusion !== 'success' || !sourceShaPattern.test(run.head_sha)
      || run.repository?.full_name?.toLowerCase() !== repo.toLowerCase()
      || run.head_repository?.full_name?.toLowerCase() !== repo.toLowerCase()) {
    throw new Error('Use a successful Mobile CI run built from this repository.');
  }
  const sourceSha = run.head_sha;
  readCommand('git', ['merge-base', '--is-ancestor', sourceSha, currentSha], 'The source run must be in the current checkout history.');
  const changed = readCommand('git', ['diff', '--name-only', '--no-renames', '-z', sourceSha, currentSha, '--'],
    'The source and current checkout trees could not be compared.').split('\0').filter(Boolean);
  if (changed.some(path => !nonBuildFiles.has(path))) throw new Error('The source run and checkout differ in build inputs.');

  const flavor = profile === 'demo' ? 'demo' : 'connected-ci';
  const apk = `mobile-android-${flavor}-${sourceSha}`;
  const smoke = `mobile-android-${flavor}-emulator-smoke-${sourceSha}`;
  const metadata = readGitHub(`${runPath}/artifacts?per_page=100`);
  const artifacts = metadata?.artifacts;
  if (!Array.isArray(artifacts) || [apk, smoke].some(name => {
    const matching = artifacts.filter(artifact => artifact?.name === name);
    return matching.length !== 1 || matching[0].expired !== false;
  })) throw new Error('The source run must have both exact, unexpired Android artifacts.');

  const outputs = `source_sha=${sourceSha}\napk_artifact_name=${apk}\nsmoke_artifact_name=${smoke}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
  process.stdout.write(outputs);
}

function readEvidence(path, maxSize) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry?.isFile() || entry.size === 0 || entry.size > maxSize) throw new Error('A downloaded artifact file is missing or invalid.');
  return readFileSync(path);
}

function expectOneLine(lines, expected) {
  if (lines.filter(line => line === expected).length !== 1) throw new Error('The prior Android smoke evidence does not match this APK and source.');
}

function verifyApk(sourceSha, profile, apkPath, smokeDirectory) {
  requireProfile(profile);
  if (!sourceShaPattern.test(sourceSha)) throw new Error('Use the validated source SHA.');
  const apkHash = createHash('sha256').update(readEvidence(apkPath, 128 * 1024 * 1024)).digest('hex');
  const runner = readEvidence(join(smokeDirectory, 'runner.txt'), 64 * 1024).toString('utf8').split(/\r?\n/);
  expectOneLine(runner, `source_sha=${sourceSha}`);
  expectOneLine(runner, `profile=${profile}`);
  expectOneLine(runner, `${apkHash}  android/app/build/outputs/apk/release/app-release.apk`);
  expectOneLine(runner, 'smoke_exit_status=0');
  const smoke = readEvidence(join(smokeDirectory, 'evidence.txt'), 64 * 1024).toString('utf8').split(/\r?\n/);
  expectOneLine(smoke, `Profile: ${profile}`);
  expectOneLine(smoke, `Package: com.crustcaper.mobile.${profile}`);
  expectOneLine(smoke, `APK SHA-256: ${apkHash}`);
  expectOneLine(smoke, `Installed APK SHA-256: ${apkHash}`);
  expectOneLine(smoke, 'Result: passed');
  process.stdout.write(`Verified ${profile} APK ${apkHash} from ${sourceSha}.\n`);
}

try {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'source' && args.length === 2) checkSource(...args);
  else if (mode === 'verify' && args.length === 4) verifyApk(...args);
  else throw new Error('Usage: prepare-android-minimum-ci.cjs source RUN_ID PROFILE | verify SOURCE_SHA PROFILE APK_PATH SMOKE_DIR');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
