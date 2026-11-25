import { ApiError } from '../domain/types';

export const PDF_MIME_TYPE = 'application/pdf';
export const MAX_RECEIPT_BYTES = 1024 * 1024;

const pdfWhitespace = [0, 9, 10, 12, 13, 32];

function invalidReceipt(): never {
  throw new ApiError('invalid_response');
}

export async function readReceiptPdf(response: Pick<Response, 'headers' | 'body'>): Promise<Uint8Array> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== PDF_MIME_TYPE) {
    invalidReceipt();
  }
  const lengthHeader = response.headers.get('content-length');
  const length = lengthHeader === null ? null : Number(lengthHeader);
  if (length !== null && (!/^\d+$/.test(lengthHeader ?? '') || length < 13 || length > MAX_RECEIPT_BYTES)) invalidReceipt();

  const reader = response.body?.getReader();
  if (!reader) invalidReceipt();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      count += chunk.value.byteLength;
      if (count > MAX_RECEIPT_BYTES) invalidReceipt();
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const encoding = response.headers.get('content-encoding');
  if (count < 13 || (length !== null && (!encoding || encoding === 'identity') && length !== count)) invalidReceipt();
  const bytes = new Uint8Array(count);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  if (!/^%PDF-[0-9]\.[0-9]$/.test(String.fromCharCode(...bytes.subarray(0, 8)))) invalidReceipt();

  let end = bytes.length;
  while (end > 0 && pdfWhitespace.includes(bytes[end - 1] ?? -1)) end--;
  if (end < 13 || String.fromCharCode(...bytes.subarray(end - 5, end)) !== '%%EOF') invalidReceipt();
  return bytes;
}
