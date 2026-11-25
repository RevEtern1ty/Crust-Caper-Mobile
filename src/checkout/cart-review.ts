import type { CartLine, Product, Quote } from '../domain/types';
import { compareReorder } from './reorder-review';

export function reviewCheckoutCart(cart: readonly CartLine[], quote: Pick<Quote, 'lines' | 'changes'>) {
  const { available, removed } = compareReorder(cart, quote.lines);
  const requiresCartEdit = !available.length || removed.length > 0
    || available.some(({ current, previous }) => previous?.quantity !== current.quantity)
    || quote.changes.some(({ kind }) => kind === 'unavailable');

  return { available, removed, requiresCartEdit };
}

export function cartLineUnavailable(line: CartLine, product: Product | undefined): 'item' | 'options' | null {
  if (!product?.available) return 'item';
  if (line.modifierIds.some(id => !product.modifiers.some(option => option.id === id))) return 'options';
  return null;
}
