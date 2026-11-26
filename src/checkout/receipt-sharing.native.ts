import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { Platform } from 'react-native';
import { ApiError } from '../domain/types';
import { PDF_MIME_TYPE } from '../live/receipt';

const receivingAppGraceMs = 2 * 60 * 1000;
const receiptDirectoryName = 'crustcaper-receipt-sharing';
const taskNamePattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const activeTasks = new Set<string>();

function removeTask(directory: Directory) {
  try {
    if (directory.exists) directory.delete();
  } catch {
    // A later foreground sweep or the operating system cache eviction can retry cleanup.
  }
}

export function purgeExpiredReceiptFiles() {
  try {
    const directory = new Directory(Paths.cache, receiptDirectoryName);
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

export async function shareReceipt(bytes: Uint8Array, fileName: string, dialogTitle: string, canShare: () => boolean): Promise<void> {
  const available = await isAvailableAsync();
  if (!canShare()) return;
  if (!available) throw new ApiError('service_unavailable');

  const task = randomUUID();
  const directory = new Directory(Paths.cache, receiptDirectoryName, task);
  const file = new File(directory, fileName);
  let shared = false;
  try {
    directory.create({ intermediates: true });
    activeTasks.add(task);
    file.create();
    file.write(bytes);
    if (!canShare()) return;
    await shareAsync(file.uri, { dialogTitle, mimeType: PDF_MIME_TYPE, UTI: 'com.adobe.pdf' });
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
