import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { Platform } from 'react-native';
import { ApiError } from '../domain/types';
import { PDF_MIME_TYPE } from '../live/receipt';

const receivingAppGraceMs = 2 * 60 * 1000;
// Keep sweeping the same cache directory across app upgrades.
const shareDirectoryName = 'crustcaper-receipt-sharing';
const taskNamePattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const activeTasks = new Set<string>();

function removeTask(directory: Directory) {
  try {
    if (directory.exists) directory.delete();
  } catch {
    // A later foreground sweep or the operating system cache eviction can retry cleanup.
  }
}

export function purgeExpiredSharedDocuments() {
  try {
    const directory = new Directory(Paths.cache, shareDirectoryName);
    if (!directory.exists) return;

    const cutoff = Date.now() - receivingAppGraceMs;
    for (const task of directory.list()) {
      if (task instanceof Directory && taskNamePattern.test(task.name) && !activeTasks.has(task.name)
        && (task.info().modificationTime ?? 0) <= cutoff) {
        removeTask(task);
      }
    }
  } catch {
    // Cleanup must not block opening the app.
  }
}

export function shareReceipt(bytes: Uint8Array, fileName: string, dialogTitle: string, canShare: () => boolean) {
  return shareDocument(bytes, fileName, { dialogTitle, mimeType: PDF_MIME_TYPE, UTI: 'com.adobe.pdf' }, canShare);
}

export function shareOrderData(json: string, dialogTitle: string, canShare: () => boolean) {
  return shareDocument(json, 'crustcaper-order-data.json',
    { dialogTitle, mimeType: 'application/json', UTI: 'public.json' }, canShare);
}

async function shareDocument(
  content: string | Uint8Array,
  fileName: string,
  options: Parameters<typeof shareAsync>[1],
  canShare: () => boolean,
) {
  const available = await isAvailableAsync();
  if (!canShare()) return;
  if (!available) throw new ApiError('service_unavailable');

  const task = randomUUID();
  const directory = new Directory(Paths.cache, shareDirectoryName, task);
  const file = new File(directory, fileName);
  let shared = false;
  try {
    directory.create({ intermediates: true });
    activeTasks.add(task);
    file.create();
    file.write(content);
    if (!canShare()) return;
    await shareAsync(file.uri, options);
    shared = true;
  } finally {
    const cleanUp = () => {
      activeTasks.delete(task);
      removeTask(directory);
    };
    // Android reports the chooser result before a receiving app necessarily finishes reading the URI.
    if (Platform.OS === 'android' && shared) setTimeout(cleanUp, receivingAppGraceMs);
    else cleanUp();
  }
}
