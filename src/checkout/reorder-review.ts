import { lineKey } from '../domain/cart';
import type { CartLine } from '../domain/types';

function sumLines(lines: readonly CartLine[]) {
  return lines.reduce((total, line) => total + line.unitPrice * line.quantity, 0);
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
