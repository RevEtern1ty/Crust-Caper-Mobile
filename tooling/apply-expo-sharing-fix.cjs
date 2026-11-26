const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const supportedVersion = '55.0.25';
const originalDigest = '1619b86fd699d22315ea419a6a881aa21b3c844f59a43a377125d595a066f83f';
const patchedDigest = '633a8c81b3939bafcb52aba4cd9b204f76da7e81c300f9b256cca2ce10395d5d';
const packagePath = require.resolve('expo-sharing/package.json');
const { version } = JSON.parse(readFileSync(packagePath, 'utf8'));
if (version !== supportedVersion) {
  throw new Error('Recheck the iOS completion backport for the installed expo-sharing version.');
}

// Backport the iOS completion handler from expo-sharing 56.0.7 to SDK 55.
// https://github.com/expo/expo/blob/40f0a6f6711d93762e0506b37e6e077e4bd9a541/packages/expo-sharing/ios/SharingModule.swift#L19-L29
const before = [
  '      activityController.completionWithItemsHandler = { type, completed, _, _ in',
  '        // user shared an item',
  '        if type != nil && completed {',
  '          promise.resolve(nil)',
  '        }',
  '',
  '        // dismissed without action',
  '        if type == nil && !completed {',
  '          promise.resolve(nil)',
  '        }',
  '      }',
].join('\n');
const after = [
  '      activityController.completionWithItemsHandler = { _, _, _, _ in',
  '        promise.resolve(nil)',
  '      }',
].join('\n');

function sourceDigest(source) {
  return createHash('sha256').update(source.replaceAll('\r\n', '\n')).digest('hex');
}

const sourcePath = join(dirname(packagePath), 'ios', 'SharingModule.swift');
const source = readFileSync(sourcePath, 'utf8');
const digest = sourceDigest(source);
if (digest !== patchedDigest) {
  if (digest !== originalDigest) {
    throw new Error('Unexpected expo-sharing iOS source. Recheck the completion backport.');
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const patched = source.replace(before.replaceAll('\n', newline), after.replaceAll('\n', newline));
  if (sourceDigest(patched) !== patchedDigest) {
    throw new Error('The expo-sharing iOS completion backport did not match the original handler.');
  }
  writeFileSync(sourcePath, patched);
}
