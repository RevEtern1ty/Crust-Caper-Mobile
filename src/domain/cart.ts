import type { CartLine } from './types';

export const MAX_QUANTITY = 9;
export const MAX_SHARED_QUANTITY = 99;

export function lineKey(line: Pick<CartLine, 'sku' | 'modifierIds'>) {
  return JSON.stringify([line.sku, [...line.modifierIds].sort()]);
}
