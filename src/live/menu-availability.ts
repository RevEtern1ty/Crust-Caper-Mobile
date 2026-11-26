import type { Menu } from '../domain/types';

type MenuAvailability = Pick<Menu, 'availabilityCheckedAt' | 'nextSaleChangeAt'>;

const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

export function saleRefreshDelay(availability: MenuAvailability): number | null {
  const checkedAt = Date.parse(availability.availabilityCheckedAt ?? '');
  const nextChange = Date.parse(availability.nextSaleChangeAt ?? '');
  const delay = nextChange - checkedAt;
  return delay > 0 && delay <= oneWeekMs ? delay : null;
}

export function menuAvailability(headers: Headers): MenuAvailability {
  const checkedAt = headers.get('X-Availability-Checked-At');
  const availabilityCheckedAt = checkedAt && Number.isFinite(Date.parse(checkedAt)) ? checkedAt : undefined;
  const nextSaleChangeAt = headers.get('X-Next-Sale-Change-At') ?? undefined;
  const observed = { availabilityCheckedAt, nextSaleChangeAt };
  return saleRefreshDelay(observed) === null ? { availabilityCheckedAt } : observed;
}
