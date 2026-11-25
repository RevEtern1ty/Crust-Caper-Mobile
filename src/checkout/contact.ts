export function normalizePhone(value: string): string | null {
  const phone = value.replace(/[\s()-]/g, '');
  return /^\+[1-9][0-9]{7,14}$/.test(phone) ? phone : null;
}
