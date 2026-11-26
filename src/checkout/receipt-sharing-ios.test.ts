import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const runSwift = process.platform === 'darwin'
  || (process.platform === 'linux' && process.env.CRUSTCAPER_TEST_SWIFT === '1');

function installedCompletionHandler() {
  const packageRoot = dirname(require.resolve('expo-sharing/package.json'));
  const source = readFileSync(join(packageRoot, 'ios', 'SharingModule.swift'), 'utf8');
  const handler = /^([ \t]+)activityController\.completionWithItemsHandler\s*=\s*(\{[^\r\n]*\r?\n[\s\S]*?^\1\})/m.exec(source)?.[2];
  assert.ok(handler, 'The installed Expo Sharing UIKit completion handler must be present');
  return handler;
}

test('the installed iOS receipt sharing callback settles for every activity result', () => {
  const handler = installedCompletionHandler();
  const statements = handler.slice(handler.indexOf('\n') + 1, handler.lastIndexOf('}'))
    .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//'));
  assert.deepEqual(statements, ['promise.resolve(nil)'], 'Cancellation after selecting an activity must resolve the Promise');
});

test('the installed Swift sharing handler resolves every UIKit callback exactly once', {
  skip: !runSwift && 'Requires macOS or CRUSTCAPER_TEST_SWIFT=1 on Linux',
}, () => {
  const handler = installedCompletionHandler();
  const program = `
struct Activity: Equatable {}
enum ActivityFailure: Error { case fixture }
final class ReceiptPromise {
  private(set) var resolutionCount = 0
  func resolve(_ value: Any?) {
    precondition(value == nil, "The receipt API resolves void")
    resolutionCount += 1
  }
}
typealias Completion = (Activity?, Bool, [Any]?, (any Error)?) -> Void
let results: [(Activity?, Bool, (any Error)?)] = [
  (nil, false, nil),
  (Activity(), false, nil),
  (Activity(), true, nil),
  (nil, true, nil),
  (Activity(), false, ActivityFailure.fixture),
  (nil, false, ActivityFailure.fixture)
]
for (activity, completed, error) in results {
  let promise = ReceiptPromise()
  let callback: Completion = ${handler}
  callback(activity, completed, nil, error)
  precondition(promise.resolutionCount == 1, "Each UIKit completion must settle exactly once")
}
`;
  const result = spawnSync('swift', ['-'], { input: program, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
