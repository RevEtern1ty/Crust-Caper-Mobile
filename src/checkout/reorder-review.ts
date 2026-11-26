import { lineKey, MAX_QUANTITY } from '../domain/cart';
import type { CartLine, ReorderResult } from '../domain/types';

function sumLines(lines: readonly CartLine[]) {
  return lines.reduce((total, line) => total + line.unitPrice * line.quantity, 0);
}

export function reorderOfferForCart(offer: ReorderResult): ReorderResult {
  return {
    ...offer,
    lines: offer.lines.map(line => line.quantity > MAX_QUANTITY ? { ...line, quantity: MAX_QUANTITY } : line),
  };
}

export function compareReorder(original: readonly CartLine[], offer: readonly CartLine[]) {
  const remaining = [...original];
  const available = offer.map((current) => {
    const key = lineKey(current);
    const index = remaining.findIndex((line) => lineKey(line) === key);
    const previous = index === -1 ? undefined : remaining.splice(index, 1)[0];
    return { current, previous };
  });

  return {
    available,
    removed: remaining,
    originalTotal: sumLines(original),
    estimate: sumLines(offer),
  };
}
