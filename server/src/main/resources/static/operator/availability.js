const maxPickupLimit = 2_147_483_647;
const kigaliDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', day: 'numeric', month: 'short' });
const kigaliTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function pickupWindow(slot) {
  const start = new Date(slot.startsAt);
  const end = new Date(slot.endsAt);
  const day = kigaliDay.format(start);
  const endDay = kigaliDay.format(end);
  return `${day}, ${kigaliTime.format(start)}–${day === endDay ? '' : `${endDay}, `}${kigaliTime.format(end)} Kigali time`;
}

function isPickupLimit(value) {
  return Number.isInteger(value) && value >= 0 && value <= maxPickupLimit;
}

function validPickupWindows(slots) {
  return Array.isArray(slots) && slots.length <= 36 && slots.every((slot) => slot && typeof slot.id === 'string'
    && slot.id && typeof slot.startsAt === 'string' && typeof slot.endsAt === 'string'
    && Date.parse(slot.startsAt) < Date.parse(slot.endsAt) && isPickupLimit(slot.capacity) && isPickupLimit(slot.reserved))
    && new Set(slots.map(({ id }) => id)).size === slots.length;
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

  let snapshot = null;
  let busy = false;
  let verified = false;
  let selectedSlotId = null;

  function syncButtons() {
    refresh.disabled = busy;
    storeToggle.disabled = busy || !verified;
    list.querySelectorAll('button').forEach((button) => { button.disabled = busy || !verified; });
    pickupLimitForm.setAttribute('aria-busy', String(busy));
    const slotDisabled = busy || !verified || selectedSlotId === null;
    pickupWindowSelect.disabled = slotDisabled;
    pickupLimitInput.disabled = slotDisabled;
    pickupLimitSave.disabled = slotDisabled;
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

  function render() {
    store.hidden = snapshot === null;
    renderPickupLimits();
    if (!snapshot) {
      list.replaceChildren();
      syncButtons();
      return;
    }

    storeStatus.textContent = snapshot.open ? 'Accepting new orders' : 'New orders paused';
    storeToggle.textContent = snapshot.open ? 'Pause new orders' : 'Accept new orders';
    list.replaceChildren(...snapshot.products.map((product) => {
      const row = template.content.firstElementChild.cloneNode(true);
      row.querySelector('.order-title').textContent = product.name.en;
      const badge = row.querySelector('.order-status');
      badge.dataset.status = product.available ? 'ready' : 'accepted';
      badge.textContent = product.available ? 'Available' : 'On stop list';
      const button = row.querySelector('button');
      const action = product.available ? 'Put on stop list' : 'Resume item';
      button.textContent = action;
      button.setAttribute('aria-label', `${action}: ${product.name.en}`);
      button.dataset.sku = product.sku;
      button.addEventListener('click', () => {
        const notice = product.available ? `${product.name.en} is on the stop list.` : `${product.name.en} is available.`;
        void update({ sku: product.sku, available: !product.available }, notice);
      });
      return row;
    }));
    syncButtons();
  }

  function accept(data, savedLimit) {
    if (!data || typeof data.version !== 'string' || !data.version || typeof data.open !== 'boolean'
      || !Array.isArray(data.products) || data.products.some((product) => !product || typeof product.sku !== 'string'
        || !product.sku || typeof product.name?.en !== 'string' || !product.name.en || typeof product.available !== 'boolean')
      || (data.slots !== undefined && !validPickupWindows(data.slots))) {
      throw new Error('Invalid availability response');
    }
    if (savedLimit && !data.slots?.some(({ id, capacity }) => id === savedLimit.slotId && capacity === savedLimit.capacity)) {
      throw new Error('The updated pickup limit could not be verified');
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
      verified = false;
      showMessage(note);
      report(error);
    } finally {
      if (currentSession() === session) {
        busy = false;
        syncButtons();
      }
    }
  }

  async function refreshAfterLimitError(session, change, error) {
    if (error.status === 401) {
      report(error);
      return;
    }

    let message;
    const uncertain = error.status === undefined || error.status >= 500;
    if (error.code === 'slot_capacity_below_reserved') {
      message = 'The pickup limit cannot be lower than the number of active reservations.';
    } else if (error.code === 'slot_update_closed' || error.status === 404) {
      message = 'This pickup window can no longer be edited.';
    } else if (error.code === 'catalog_version_conflict') {
      message = 'Availability changed. Review the current pickup limits before saving again.';
    } else if (uncertain) {
      message = 'The save could not be confirmed. Review the current pickup limits before saving again.';
    } else {
      message = messageFor(error);
    }

    try {
      const data = await request('/availability', { token: session.accessToken });
      if (currentSession() !== session) return;
      accept(data);
      if (uncertain && data.slots?.some(({ id, capacity }) => id === change.slotId && capacity === change.capacity)) {
        showMessage(pickupLimitNote, 'The current pickup limit matches your request.');
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

    showMessage(pickupLimits.hidden ? problem : pickupLimitProblem, message);
  }

  async function update(change, notice) {
    const session = currentSession();
    if (session?.role !== 'manager' || busy || !verified || !snapshot) return;

    busy = true;
    syncButtons();
    showMessage(problem);
    showMessage(note);
    const limitChange = change.slotId !== undefined;
    if (limitChange) {
      showMessage(pickupLimitProblem);
      showMessage(pickupLimitNote);
    }
    let saved = false;
    try {
      const data = await request('/availability', {
        method: 'PATCH', token: session.accessToken, body: { expectedVersion: snapshot.version, ...change },
      });
      if (currentSession() !== session) return;
      accept(data, limitChange ? change : undefined);
      saved = true;
      showMessage(limitChange ? pickupLimitNote : note, notice);
    } catch (error) {
      if (currentSession() !== session) return;
      verified = false;
      if (limitChange) {
        await refreshAfterLimitError(session, change, error);
      } else if (error.code === 'catalog_version_conflict') {
        showMessage(problem, 'Availability changed. Refresh the menu and review it before trying again.');
      } else {
        report(error);
      }
    } finally {
      if (currentSession() === session) {
        busy = false;
        syncButtons();
        if (limitChange) {
          if (!pickupLimitProblem.hidden) pickupLimitProblem.focus();
          else if (!pickupLimitNote.hidden) pickupLimitNote.focus();
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
    if (!/^\d+$/.test(raw) || !isPickupLimit(capacity) || capacity < slot.reserved) {
      const message = /^\d+$/.test(raw) && isPickupLimit(capacity)
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
      render();
    },
  };
}
