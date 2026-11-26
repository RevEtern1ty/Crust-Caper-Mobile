import { mountPickupSchedule } from './pickup-schedule.js';

const kigaliDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', day: 'numeric', month: 'short' });
const kigaliTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function pickupWindow(slot) {
  const start = new Date(slot.startsAt);
  const end = new Date(slot.endsAt);
  const day = kigaliDay.format(start);
  const endDay = kigaliDay.format(end);
  return `${day}, ${kigaliTime.format(start)}–${day === endDay ? '' : `${endDay}, `}${kigaliTime.format(end)} Kigali time`;
}

function isNonnegativeInt32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
}

function validPickupWindows(slots) {
  return Array.isArray(slots) && slots.length <= 36 && slots.every((slot) => slot && typeof slot.id === 'string'
    && slot.id && typeof slot.startsAt === 'string' && typeof slot.endsAt === 'string'
    && Date.parse(slot.startsAt) < Date.parse(slot.endsAt) && isNonnegativeInt32(slot.capacity) && isNonnegativeInt32(slot.reserved))
    && new Set(slots.map(({ id }) => id)).size === slots.length;
}

function validStock(stock) {
  return stock == null || (isNonnegativeInt32(stock.onHand) && Number.isSafeInteger(stock.reserved) && stock.reserved >= 0
    && Number.isSafeInteger(stock.revision) && stock.revision > 0);
}

function matchesChange(snapshot, change) {
  if (change.slotId !== undefined) {
    return snapshot.slots?.some(({ id, capacity }) => id === change.slotId && capacity === change.capacity);
  }
  if (change.stockOnHand !== undefined) {
    const stock = snapshot.products.find(({ sku }) => sku === change.sku)?.stock;
    return stock?.onHand === change.stockOnHand && stock.revision > (change.stockRevision ?? 0);
  }
  if (change.sku !== undefined) {
    return snapshot.products.some(({ sku, available }) => sku === change.sku && available === change.available);
  }
  return snapshot.open === change.open;
}

function writeOutcomeUnknown(error) {
  return error.status === undefined || error.status === 408 || error.status >= 500;
}

export function mountAvailability({ currentSession, request, messageFor, showMessage, closeSession }) {
  const panel = document.getElementById('availability');
  const jump = document.getElementById('availability-jump');
  const refresh = document.getElementById('availability-refresh');
  const problem = document.getElementById('availability-problem');
  const note = document.getElementById('availability-note');
  const store = document.getElementById('availability-store');
  const storeStatus = document.getElementById('availability-store-status');
  const storeToggle = document.getElementById('availability-store-toggle');
  const list = document.getElementById('availability-list');
  const template = document.getElementById('availability-template');
  const pickupLimits = document.getElementById('pickup-limits');
  const pickupLimitsEmpty = document.getElementById('pickup-limits-empty');
  const pickupLimitForm = document.getElementById('pickup-limit-form');
  const pickupWindowSelect = document.getElementById('pickup-window');
  const pickupLimitWindow = document.getElementById('pickup-limit-window');
  const pickupLimitCurrent = document.getElementById('pickup-limit-current');
  const pickupLimitReserved = document.getElementById('pickup-limit-reserved');
  const pickupLimitInput = document.getElementById('pickup-limit');
  const pickupLimitSave = document.getElementById('save-pickup-limit');
  const pickupLimitProblem = document.getElementById('pickup-limit-problem');
  const pickupLimitNote = document.getElementById('pickup-limit-note');

  const stockRows = new Map();
  let snapshot = null;
  let busy = false;
  let verified = false;
  let selectedSlotId = null;
  const schedule = mountPickupSchedule({
    currentSession, request, messageFor, showMessage, closeSession, accept,
    currentAvailability: () => ({ busy, verified, snapshot }),
    setBusy(value) {
      busy = value;
      syncButtons();
    },
    markUnverified,
  });

  function markUnverified() {
    verified = false;
    if (snapshot) {
      storeStatus.textContent = 'Order intake status unknown';
      for (const badge of list.querySelectorAll('.order-status')) {
        badge.dataset.status = 'unverified';
        badge.textContent = 'Availability unknown';
      }
      for (const row of stockRows.values()) {
        row.summary.textContent = 'Portion counts could not be verified. Refresh availability.';
      }
    }
    syncButtons();
  }

  function syncButtons() {
    refresh.disabled = busy;
    storeToggle.disabled = busy || !verified;
    list.querySelectorAll('button, input').forEach((control) => { control.disabled = busy || !verified; });
    for (const row of stockRows.values()) row.form.setAttribute('aria-busy', String(busy));
    pickupLimitForm.setAttribute('aria-busy', String(busy));
    const slotDisabled = busy || !verified || selectedSlotId === null;
    pickupWindowSelect.disabled = slotDisabled;
    pickupLimitInput.disabled = slotDisabled;
    pickupLimitSave.disabled = slotDisabled;
    schedule.sync();
  }

  function selectedSlot() {
    return snapshot?.slots?.find((slot) => slot.id === selectedSlotId);
  }

  function renderSelectedSlot() {
    const slot = selectedSlot();
    pickupLimitWindow.textContent = slot ? pickupWindow(slot) : '';
    pickupLimitCurrent.textContent = slot ? `Current limit: ${slot.capacity}` : '';
    pickupLimitReserved.textContent = slot ? `Active reservations: ${slot.reserved}` : '';
    pickupLimitInput.value = slot ? String(slot.capacity) : '';
    pickupLimitInput.removeAttribute('aria-invalid');
  }

  function renderPickupLimits() {
    const slots = snapshot?.slots;
    pickupLimits.hidden = slots === undefined;
    pickupLimitForm.hidden = !slots?.length;
    pickupLimitsEmpty.hidden = !!slots?.length;
    if (!selectedSlot()) selectedSlotId = slots?.[0]?.id ?? null;

    pickupWindowSelect.replaceChildren(...(slots ?? []).map((slot) => {
      const option = document.createElement('option');
      option.value = slot.id;
      option.textContent = pickupWindow(slot);
      return option;
    }));
    pickupWindowSelect.value = selectedSlotId ?? '';
    renderSelectedSlot();
  }

  function bindStock(row, product, index) {
    const form = row.querySelector('.availability-stock');
    const summary = form.querySelector('.availability-stock-summary');
    const input = form.querySelector('input');
    const save = form.querySelector('button');
    const problem = form.querySelector('.availability-stock-problem');
    const note = form.querySelector('.availability-stock-note');
    const stock = product.stock;
    summary.id = `stock-counts-${index}`;
    problem.id = `stock-problem-${index}`;
    summary.textContent = stock
      ? `On hand: ${stock.onHand} · Reserved portions: ${stock.reserved} · Unreserved portions: ${Math.max(0, stock.onHand - stock.reserved)}`
      : 'Portion counts have not been configured.';
    input.value = stock ? String(stock.onHand) : '';
    input.setAttribute('aria-label', `Physical portions on hand: ${product.name.en}`);
    input.setAttribute('aria-describedby', `${summary.id} ${problem.id}`);
    save.setAttribute('aria-label', `Save portions: ${product.name.en}`);
    stockRows.set(product.sku, { form, summary, problem, note });
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      showMessage(problem);
      showMessage(note);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy || !verified || currentSession()?.role !== 'manager') return;
      const value = Number(input.value);
      const valid = /^\d+$/.test(input.value) && isNonnegativeInt32(value);
      if (!valid || value < (stock?.reserved ?? 0)) {
        showMessage(problem, valid ? 'Physical portions cannot be lower than active reservations.'
          : 'Enter a whole number from 0 to 2,147,483,647.');
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      if (value === stock?.onHand) {
        showMessage(note, 'Physical portions already match this count.');
        return;
      }
      void update({ sku: product.sku, stockOnHand: value, stockRevision: stock?.revision ?? null }, 'Physical portions saved.');
    });
  }

  function render() {
    stockRows.clear();
    store.hidden = snapshot === null;
    renderPickupLimits();
    if (!snapshot) {
      list.replaceChildren();
      syncButtons();
      return;
    }

    storeStatus.textContent = snapshot.open ? 'Accepting new orders' : 'New orders paused';
    storeToggle.textContent = snapshot.open ? 'Pause new orders' : 'Accept new orders';
    list.replaceChildren(...snapshot.products.map((product, index) => {
      const row = template.content.firstElementChild.cloneNode(true);
      row.querySelector('.order-title').textContent = product.name.en;
      const badge = row.querySelector('.order-status');
      badge.dataset.status = product.available ? 'ready' : 'accepted';
      badge.textContent = product.available ? 'Available' : 'On stop list';
      const button = row.querySelector('.availability-item-toggle');
      const action = product.available ? 'Put on stop list' : 'Resume item';
      button.textContent = action;
      button.setAttribute('aria-label', `${action}: ${product.name.en}`);
      button.dataset.sku = product.sku;
      button.addEventListener('click', () => {
        const notice = product.available ? `${product.name.en} is on the stop list.` : `${product.name.en} is available.`;
        void update({ sku: product.sku, available: !product.available }, notice);
      });
      bindStock(row, product, index);
      return row;
    }));
    syncButtons();
  }

  function accept(data, savedChange) {
    if (!data || typeof data.version !== 'string' || !data.version || typeof data.open !== 'boolean'
      || !Array.isArray(data.products) || data.products.some((product) => !product || typeof product.sku !== 'string'
        || !product.sku || typeof product.name?.en !== 'string' || !product.name.en || typeof product.available !== 'boolean'
        || !validStock(product.stock))
      || (data.slots !== undefined && !validPickupWindows(data.slots))) {
      throw new Error('Invalid availability response');
    }
    if (savedChange && !matchesChange(data, savedChange)) {
      throw new Error('The availability response did not confirm the requested change');
    }
    snapshot = data;
    verified = true;
    render();
  }

  function report(error) {
    if (error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else showMessage(problem, messageFor(error));
  }

  async function load() {
    const session = currentSession();
    if (session?.role !== 'manager' || busy) return;

    busy = true;
    syncButtons();
    showMessage(problem);
    showMessage(pickupLimitProblem);
    showMessage(pickupLimitNote);
    showMessage(note, 'Loading menu availability…');
    try {
      const data = await request('/availability', { token: session.accessToken });
      if (currentSession() === session) {
        accept(data);
        showMessage(note, data.products.length ? '' : 'No menu items are configured.');
      }
    } catch (error) {
      if (currentSession() !== session) return;
      markUnverified();
      showMessage(note);
      report(error);
    } finally {
      if (currentSession() === session) {
        busy = false;
        syncButtons();
      }
    }
  }

  function quantityFeedback(change) {
    if (change.stockOnHand !== undefined) return stockRows.get(change.sku) ?? { problem, note };
    return { problem: pickupLimits.hidden ? problem : pickupLimitProblem, note: pickupLimitNote };
  }

  async function refreshAfterQuantityError(session, change, error) {
    if (error.status === 401) {
      report(error);
      return;
    }

    let message;
    const stock = change.stockOnHand !== undefined;
    const quantity = stock ? 'portion counts' : 'pickup limits';
    const uncertain = writeOutcomeUnknown(error);
    if (stock && error.code === 'stock_below_reserved') {
      message = 'Physical portions cannot be lower than active reservations.';
    } else if (stock && error.code === 'stock_revision_conflict') {
      message = 'The portion count changed. Review the current count before saving again.';
    } else if (stock && error.status === 404) {
      message = 'This menu item can no longer be edited.';
    } else if (!stock && error.code === 'slot_capacity_below_reserved') {
      message = 'The pickup limit cannot be lower than the number of active reservations.';
    } else if (!stock && (error.code === 'slot_update_closed' || error.status === 404)) {
      message = 'This pickup window can no longer be edited.';
    } else if (error.code === 'catalog_version_conflict') {
      message = `Availability changed. Review the current ${quantity} before saving again.`;
    } else if (uncertain) {
      message = `The save could not be confirmed. Review the current ${quantity} before saving again.`;
    } else {
      message = messageFor(error);
    }

    try {
      const data = await request('/availability', { token: session.accessToken });
      if (currentSession() !== session) return;
      accept(data);
      if (uncertain && matchesChange(data, change)) {
        showMessage(quantityFeedback(change).note, stock
          ? 'The current portion count matches your request.' : 'The current pickup limit matches your request.');
        return;
      }
    } catch (refreshError) {
      if (currentSession() !== session) return;
      if (refreshError.status === 401) {
        report(refreshError);
        return;
      }
      message += ' Refresh availability before trying again.';
    }

    showMessage(quantityFeedback(change).problem, message);
  }

  async function reconcileAvailability(session, change, notice) {
    try {
      const current = await request('/availability', { token: session.accessToken });
      if (currentSession() !== session) return false;
      accept(current);
      if (matchesChange(current, change)) {
        showMessage(note, notice);
        return true;
      }
      showMessage(problem, 'The current availability differs from your request. Review it before trying again.');
    } catch (error) {
      if (currentSession() !== session) return false;
      if (error.status === 401) report(error);
      else showMessage(problem, 'The current availability could not be verified. Refresh availability before trying again.');
    }
    return false;
  }

  async function update(change, notice) {
    const session = currentSession();
    if (session?.role !== 'manager' || busy || !verified || !snapshot) return;

    busy = true;
    syncButtons();
    showMessage(problem);
    showMessage(note);
    const quantityChange = change.slotId !== undefined || change.stockOnHand !== undefined;
    if (quantityChange) {
      const feedback = quantityFeedback(change);
      showMessage(feedback.problem);
      showMessage(feedback.note);
    }
    let saved = false;
    try {
      const data = await request('/availability', {
        method: 'PATCH', token: session.accessToken, body: { expectedVersion: snapshot.version, ...change },
      });
      if (currentSession() !== session) return;
      accept(data, change);
      saved = true;
      showMessage(quantityChange ? quantityFeedback(change).note : note, notice);
    } catch (error) {
      if (currentSession() !== session) return;
      markUnverified();
      if (quantityChange) {
        await refreshAfterQuantityError(session, change, error);
      } else if (writeOutcomeUnknown(error)) {
        saved = await reconcileAvailability(session, change, notice);
      } else if (error.code === 'catalog_version_conflict') {
        showMessage(problem, 'Availability changed. Refresh the menu and review it before trying again.');
      } else {
        report(error);
      }
    } finally {
      if (currentSession() === session) {
        busy = false;
        syncButtons();
        if (quantityChange) {
          const feedback = quantityFeedback(change);
          if (feedback.problem !== problem && !feedback.problem.hidden) feedback.problem.focus();
          else if (feedback.note !== note && !feedback.note.hidden) feedback.note.focus();
          else refresh.focus();
        } else if (saved) {
          const target = change.sku
            ? [...list.querySelectorAll('button')].find((button) => button.dataset.sku === change.sku)
            : storeToggle;
          target?.focus();
        }
      }
    }
  }

  jump.addEventListener('click', () => { document.getElementById('availability-title').focus(); });
  refresh.addEventListener('click', () => { void load(); });
  storeToggle.addEventListener('click', () => {
    if (!snapshot) return;
    const open = !snapshot.open;
    void update({ open }, open ? 'The restaurant is accepting new orders.' : 'New orders are paused.');
  });
  pickupWindowSelect.addEventListener('change', () => {
    if (busy || !verified) return;
    selectedSlotId = pickupWindowSelect.value;
    showMessage(pickupLimitProblem);
    showMessage(pickupLimitNote);
    renderSelectedSlot();
  });
  pickupLimitInput.addEventListener('input', () => {
    pickupLimitInput.removeAttribute('aria-invalid');
    showMessage(pickupLimitProblem);
    showMessage(pickupLimitNote);
  });
  pickupLimitForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const slot = selectedSlot();
    if (busy || !verified || !slot || currentSession()?.role !== 'manager') return;
    const raw = pickupLimitInput.value;
    const capacity = Number(raw);
    if (!/^\d+$/.test(raw) || !isNonnegativeInt32(capacity) || capacity < slot.reserved) {
      const message = /^\d+$/.test(raw) && isNonnegativeInt32(capacity)
        ? 'The pickup limit cannot be lower than the number of active reservations.'
        : 'Enter a whole number from 0 to 2,147,483,647.';
      pickupLimitInput.setAttribute('aria-invalid', 'true');
      showMessage(pickupLimitProblem, message);
      pickupLimitInput.focus();
      return;
    }

    void update({ slotId: slot.id, capacity }, 'Pickup limit saved.');
  });

  return {
    show() {
      panel.hidden = false;
      jump.hidden = false;
      void load();
    },
    reset() {
      panel.hidden = true;
      jump.hidden = true;
      snapshot = null;
      busy = false;
      verified = false;
      selectedSlotId = null;
      showMessage(problem);
      showMessage(note);
      showMessage(pickupLimitProblem);
      showMessage(pickupLimitNote);
      schedule.reset();
      render();
    },
  };
}
