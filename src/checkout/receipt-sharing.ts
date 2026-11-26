import { PDF_MIME_TYPE } from '../live/receipt';

export function purgeExpiredReceiptFiles() {
  // Browser downloads use object URLs and do not create an application cache file.
}

export async function shareReceipt(bytes: Uint8Array, fileName: string, _dialogTitle: string, canShare: () => boolean): Promise<void> {
  if (!canShare()) return;
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: PDF_MIME_TYPE }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Let the download take ownership of the Blob before releasing its URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
