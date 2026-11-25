import type { CartLine } from './types';

export function lineKey(line: Pick<CartLine, 'sku' | 'modifierIds'>) {
  return JSON.stringify([line.sku, [...line.modifierIds].sort()]);
}
