import brand from '../../assets/brand-mark.png';
import caperHeat from '../../assets/menu/caper-heat.jpg';
import classicSmash from '../../assets/menu/classic-smash.jpg';
import crispyChicken from '../../assets/menu/crispy-chicken.jpg';
import doubleSmash from '../../assets/menu/double-smash.jpg';
import fries from '../../assets/menu/fries.jpg';
import softDrink from '../../assets/menu/soft-drink.jpg';
import veggieCrunch from '../../assets/menu/veggie-crunch.jpg';
import type { CatalogMenu } from '../lib/catalog';

const menuPhotos: ReadonlyMap<string, string> = new Map([
  ['caper-heat', caperHeat.src],
  ['classic-smash', classicSmash.src],
  ['crispy-chicken', crispyChicken.src],
  ['double-smash', doubleSmash.src],
  ['fries', fries.src],
  ['soft-drink', softDrink.src],
  ['veggie-crunch', veggieCrunch.src],
]);

export const brandMark = brand.src;

export function photoFor(product: Pick<CatalogMenu['products'][number], 'sku' | 'photoUrl'>, illustrative: boolean): string | undefined {
  return product.photoUrl || (illustrative ? menuPhotos.get(product.sku) : undefined);
}
