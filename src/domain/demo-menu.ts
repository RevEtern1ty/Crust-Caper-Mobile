import type { Localized, Menu, Modifier, Product, Store } from './types'

export const DEMO_STORE_ID = 'kigali'
export const SLOT_DURATION = 10 * 60_000

const text = (en: string, rw: string): Localized => ({ en, rw })

const demoStore: Store = {
  id: DEMO_STORE_ID,
  name: text('CrustCaper Kigali', 'CrustCaper Kigali'),
  area: text('Kigali, Rwanda', 'Kigali, u Rwanda'),
  hours: text('Address and opening hours to be confirmed', 'Aderesi n’amasaha yo gufungura bizatangazwa'),
  open: true,
}

const beef = text('Beef', 'Inyama z’inka')
const bread = text('Toasted bun', 'Umugati utwitswe buhoro')
const cheese = text('Cheese', 'Foromaje')
const pickles = text('Pickled cucumber', 'Concombre yashyizwe muri vinaigre')
const sauce = text('House sauce', 'Isosi yihariye')
const fries = text('Fries', 'Ibirayi bikaranze')
const drink = text('Soft drink', 'Ikinyobwa kidasembuye')
const gluten = text('Gluten', 'Gluten')
const milk = text('Milk', 'Amata')
const eggs = text('Eggs', 'Amagi')
const mustard = text('Mustard', 'Moutarde')

const modifiers: Modifier[] = [
  { id: 'extra-cheese', name: text('Extra cheese', 'Foromaje y’inyongera'), price: 500 },
  { id: 'no-pickles', name: text('No pickles', 'Nta concombre'), price: 0 },
]

const productFixtures: Product[] = [
  {
    sku: 'classic-smash',
    name: text('Classic Smash', 'Classic Smash'),
    description: text('One smashed beef patty with cheese and house sauce.',
      'Akabumbe kamwe k’inyama z’inka, foromaje n’isosi yihariye.'),
    ingredients: [bread, beef, cheese, pickles, sauce],
    allergens: [gluten, milk, eggs, mustard],
    category: 'burgers',
    price: 6900,
    modifiers,
    available: true,
  },
  {
    sku: 'double-smash',
    name: text('Double Smash', 'Double Smash'),
    description: text('Two smashed beef patties, double cheese, pickles and house sauce.',
      'Utubumbe tubiri tw’inyama z’inka, foromaje ebyiri, concombre n’isosi yihariye.'),
    ingredients: [bread, beef, cheese, pickles, sauce],
    allergens: [gluten, milk, eggs, mustard],
    category: 'burgers',
    price: 9200,
    modifiers,
    available: true,
  },
  {
    sku: 'caper-heat',
    name: text('Caper Heat', 'Caper Heat'),
    description: text('Double beef and cheese with a hot caper and cucumber dressing.',
      'Inyama z’inka ebyiri, foromaje n’isosi irimo urusenda, câpres na concombre.'),
    ingredients: [bread, beef, cheese, pickles, text('Hot caper dressing', 'Isosi y’urusenda na câpres')],
    allergens: [gluten, milk, eggs, mustard],
    category: 'burgers',
    price: 9900,
    modifiers,
    available: true,
  },
  {
    sku: 'crispy-chicken',
    name: text('Crispy Chicken', 'Crispy Chicken'),
    description: text('Crispy chicken fillet, crunchy slaw, pickles and sauce.',
      'Igice cy’inkoko gikaranze, salade y’amashu, concombre n’isosi.'),
    ingredients: [bread, text('Chicken', 'Inyama z’inkoko'), text('Slaw', 'Salade y’amashu'), pickles, sauce],
    allergens: [gluten, eggs, mustard],
    category: 'burgers',
    price: 8300,
    modifiers,
    available: true,
  },
  {
    sku: 'veggie-crunch',
    name: text('Veggie Crunch', 'Veggie Crunch'),
    description: text('Vegetable patty with slaw, pickles and sauce.',
      'Akabumbe k’imboga, salade y’amashu, concombre n’isosi.'),
    ingredients: [bread, text('Vegetable patty', 'Akabumbe k’imboga'), text('Slaw', 'Salade y’amashu'), pickles, sauce],
    allergens: [gluten, eggs, mustard],
    category: 'burgers',
    price: 7800,
    modifiers,
    available: true,
  },
  {
    sku: 'double-combo',
    name: text('Double Combo', 'Double Combo'),
    description: text('Double Smash with fries and a soft drink.',
      'Double Smash, ibirayi bikaranze n’ikinyobwa kidasembuye.'),
    ingredients: [bread, beef, cheese, pickles, sauce, fries, drink],
    allergens: [gluten, milk, eggs, mustard],
    category: 'combos',
    price: 12400,
    modifiers,
    available: true,
  },
  {
    sku: 'lunch-smash',
    name: text('Lunch Smash', 'Lunch Smash'),
    description: text('Classic Smash with a small side of fries.',
      'Classic Smash n’umugabane muto w’ibirayi bikaranze.'),
    ingredients: [bread, beef, cheese, pickles, sauce, fries],
    allergens: [gluten, milk, eggs, mustard],
    category: 'combos',
    price: 7900,
    modifiers,
    available: true,
  },
  {
    sku: 'fries',
    name: text('Golden Fries', 'Ibirayi bikaranze'),
    description: text('Crisp fries with a little salt, 150 g.', 'Ibirayi bikaranze birimo umunyu muke, 150 g.'),
    ingredients: [text('Potatoes', 'Ibirayi'), text('Oil', 'Amavuta'), text('Salt', 'Umunyu')],
    allergens: [],
    category: 'sides',
    price: 2500,
    modifiers: [],
    available: true,
  },
  {
    sku: 'soft-drink',
    name: text('Soft Drink', 'Ikinyobwa kidasembuye'),
    description: text('A chilled soft drink, 330 ml.', 'Ikinyobwa gikonje kidasembuye, 330 ml.'),
    ingredients: [],
    allergens: [],
    category: 'drinks',
    price: 1500,
    modifiers: [],
    available: true,
  },
]

export function createDemoMenu(now: number): Menu {
  const firstSlot = (Math.floor(now / SLOT_DURATION) + 1) * SLOT_DURATION
  return {
    version: 'demo-1',
    updatedAt: new Date(now).toISOString(),
    store: demoStore,
    products: productFixtures,
    slots: Array.from({ length: 6 }, (_, offset) => {
      const startsAt = firstSlot + offset * SLOT_DURATION
      return {
        id: `slot-${startsAt}`,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(startsAt + SLOT_DURATION).toISOString(),
        available: true,
      }
    }),
  }
}
