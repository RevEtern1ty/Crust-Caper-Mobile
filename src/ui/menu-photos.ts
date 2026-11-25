import type { ImageSourcePropType } from 'react-native';

const photos: Record<string, ImageSourcePropType> = {
  'double-smash': require('../../assets/menu/double-smash.jpg'),
  'classic-smash': require('../../assets/menu/classic-smash.jpg'),
  'caper-heat': require('../../assets/menu/caper-heat.jpg'),
  'crispy-chicken': require('../../assets/menu/crispy-chicken.jpg'),
  'veggie-crunch': require('../../assets/menu/veggie-crunch.jpg'),
  fries: require('../../assets/menu/fries.jpg'),
  'soft-drink': require('../../assets/menu/soft-drink.jpg'),
};

export function menuPhoto(sku: string) {
  const featuredSku = sku === 'double-combo' ? 'double-smash' : sku === 'lunch-smash' ? 'classic-smash' : sku;
  return photos[featuredSku];
}
