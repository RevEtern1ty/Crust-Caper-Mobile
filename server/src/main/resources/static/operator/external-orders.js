const channelId = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const reference = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const wallTime = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/;
const activeStatuses = new Set(['accepted', 'preparing', 'ready']);
const terminalStatuses = new Set(['collected', 'cancelled']);
const labels = { accepted: 'accepted', preparing: 'preparing', ready: 'ready for handoff', collected: 'handed off', cancelled: 'cancelled' };
const maxLines = 30;
const maxModifiers = 12;
const maxOrderBytes = 64 * 1024;

function textField(value, limit = 120) {
  return typeof value === 'string' && value.length > 0 && [...value].length <= limit;
}

function instant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function readExternalOrder(data, activeOnly = false) {
  if (!data || typeof data.id !== 'string' || !uuid.test(data.id) || typeof data.channel !== 'string' || !channelId.test(data.channel)
    || !textField(data.channelLabel, 80) || typeof data.externalReference !== 'string' || !reference.test(data.externalReference)
    || !instant(data.scheduledAt) || !instant(data.acceptedAt)
    || (!activeStatuses.has(data.status) && (activeOnly || !terminalStatuses.has(data.status)))
    || typeof data.confirmedByCurrentOperator !== 'boolean'
    || (data.confirmedByCurrentOperator && data.status !== 'collected')
    || !Array.isArray(data.lines) || !data.lines.length || data.lines.length > maxLines
    || !data.lines.every((line) => line && textField(line.name) && Number.isInteger(line.quantity)
      && line.quantity >= 1 && line.quantity <= 99 && Array.isArray(line.modifiers) && line.modifiers.length <= maxModifiers
      && line.modifiers.every((modifier) => textField(modifier)))) throw new Error('Invalid delivery order response');

  return {
    id: data.id, external: true, channel: data.channel, channelLabel: data.channelLabel, externalReference: data.externalReference,
    scheduledAt: data.scheduledAt, acceptedAt: data.acceptedAt, status: data.status, confirmedByCurrentOperator: data.confirmedByCurrentOperator,
    lines: data.lines.map(({ name, quantity, modifiers }) => ({ name, quantity, modifiers })),
  };
}

export function mountExternalOrders({
  currentSession, request, showMessage, messageFor, closeSession, queueFresh, isCurrent, onOrder, syncQueue,
}) {
  const element = (name) => document.getElementById(`external-${name}`);
  const jump = element('order-jump');
  const panel = element('order-intake');
  const title = element('order-intake-title');
  const channelStatus = element('channel-status');
  const reload = element('channel-reload');
  const form = element('order-form');
  const fields = element('order-fields');
  const channel = element('order-channel');
  const ref = element('order-reference');
  const time = element('order-time');
  const items = element('order-items');
  const addItemButton = element('order-add-item');
  const saveButton = element('order-save');
  const formProblem = element('order-problem');
  const itemTemplate = element('item-template');
  const modifierTemplate = element('modifier-template');
  const notice = element('queue-notice');
  const pendingNotice = element('pending-notice');
  const dialog = element('cancellation-dialog');
  const dialogTitle = element('cancellation-title');
  const dialogForm = element('cancellation-form');
  const pendingTransitions = new Map();
  let channels = [];
  let loading = false;
  let saving = false;
  let pendingOrder = null;
  let cancellation = null;

  const canIntake = (session) => session?.role === 'pickup' || session?.role === 'manager';

  function expired(error) {
    if (error.status !== 401) return false;
    closeSession('Your staff session expired. Sign in again.');
    return true;
  }

  async function loadChannels() {
    const current = currentSession();
    if (!canIntake(current) || loading || saving || pendingOrder) return;
    loading = true;
    reload.hidden = true;
    showMessage(channelStatus, 'Loading delivery platforms…');
    try {
      const data = await request('/external-order-channels', { token: current.accessToken });
      if (currentSession() !== current) return;
      if (!Array.isArray(data?.channels) || !data.channels.every((entry) => entry && typeof entry.id === 'string'
        && channelId.test(entry.id) && textField(entry.label, 80)) || new Set(data.channels.map(({ id }) => id)).size !== data.channels.length) {
        throw new Error('Invalid delivery platform response');
      }
      channels = data.channels;
      const previous = channel.value;
      channel.replaceChildren(...channels.map(({ id, label }) => new Option(label, id)));
      if (channels.some(({ id }) => id === previous)) channel.value = previous;
      form.hidden = !channels.length;
      reload.hidden = !!channels.length;
      showMessage(channelStatus, channels.length ? '' : 'No delivery platforms are configured for this restaurant.');
    } catch (error) {
      if (currentSession() !== current || expired(error)) return;
      form.hidden = true;
      reload.hidden = false;
      showMessage(channelStatus, 'Delivery platforms could not be loaded. Try again.');
    } finally {
      if (currentSession() === current) loading = false;
    }
  }

  function syncItemButtons() {
    addItemButton.disabled = items.children.length >= maxLines;
    [...items.children].forEach((item, index) => {
      item.querySelector('legend').textContent = `Item ${index + 1}`;
      item.querySelector('.external-remove-item').hidden = items.children.length === 1;
    });
  }

  function addItem(focus) {
    if (items.children.length >= maxLines) return;
    const item = itemTemplate.content.firstElementChild.cloneNode(true);
    const modifiers = item.querySelector('.external-modifiers');
    const addModifier = item.querySelector('.external-add-modifier');
    const name = item.querySelector('input[name="itemName"]');
    addModifier.addEventListener('click', () => {
      if (modifiers.children.length >= maxModifiers) return;
      const row = modifierTemplate.content.firstElementChild.cloneNode(true);
      row.querySelector('button').addEventListener('click', () => {
        row.remove();
        addModifier.disabled = false;
        addModifier.focus();
      });
      modifiers.append(row);
      addModifier.disabled = modifiers.children.length >= maxModifiers;
      row.querySelector('input').focus();
    });
    item.querySelector('.external-remove-item').addEventListener('click', () => {
      if (items.children.length === 1) return;
      item.remove();
      syncItemButtons();
      addItemButton.focus();
    });
    items.append(item);
    syncItemButtons();
    if (focus) name.focus();
  }

  function resetForm() {
    form.reset();
    items.replaceChildren();
    addItem(false);
    for (const field of form.querySelectorAll('[aria-invalid]')) field.removeAttribute('aria-invalid');
    showMessage(formProblem);
  }

  function invalid(field, message) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
    showMessage(formProblem, message);
    return null;
  }

  function readForm() {
    if (!channels.some(({ id }) => id === channel.value)) return invalid(channel, 'Choose a delivery platform.');
    if (!reference.test(ref.value)) return invalid(ref, 'Enter the external reference using up to 64 letters, numbers, periods, underscores, slashes or hyphens.');
    // Current Kigali schedules use UTC+02:00. Interpret the input in the restaurant's time zone.
    const localTime = time.value;
    const date = new Date(`${localTime}:00+02:00`);
    if (!wallTime.test(localTime) || localTime.startsWith('0000-') || !time.validity.valid || !Number.isFinite(date.valueOf())) {
      return invalid(time, 'Choose a date and time in Kigali.');
    }
    const lines = [];
    for (const item of items.children) {
      const name = item.querySelector('input[name="itemName"]');
      const quantity = item.querySelector('input[name="quantity"]');
      if (!textField(name.value.trim())) return invalid(name, 'Enter an item name up to 120 characters.');
      if (!/^\d{1,2}$/.test(quantity.value) || !quantity.validity.valid) return invalid(quantity, 'Enter a whole quantity from 1 to 99.');
      const modifiers = [];
      for (const modifier of item.querySelectorAll('input[name="modifierName"]')) {
        if (!textField(modifier.value.trim())) return invalid(modifier, 'Enter a modifier name up to 120 characters or remove that modifier.');
        modifiers.push(modifier.value.trim());
      }
      lines.push({ name: name.value.trim(), quantity: Number(quantity.value), modifiers });
    }
    return { channel: channel.value, externalReference: ref.value, scheduledAt: date.toISOString(), lines };
  }

  function syncForm() {
    form.setAttribute('aria-busy', String(saving));
    fields.disabled = saving || pendingOrder !== null;
    saveButton.disabled = saving;
    saveButton.textContent = saving ? 'Saving delivery order…' : pendingOrder ? 'Retry delivery order' : 'Save delivery order';
  }

  async function save(event) {
    event.preventDefault();
    const current = currentSession();
    if (!canIntake(current) || saving || form.hidden) return;
    const payload = pendingOrder ?? readForm();
    if (!payload) return;
    if (!pendingOrder && new TextEncoder().encode(JSON.stringify(payload)).length > maxOrderBytes) {
      showMessage(formProblem, 'The delivery order is too large to save. Shorten the item or modifier names.');
      return;
    }
    const wasPending = pendingOrder !== null;
    saving = true;
    showMessage(formProblem);
    showMessage(notice);
    syncForm();
    try {
      const order = readExternalOrder(await request('/external-orders', { token: current.accessToken, method: 'POST', body: payload }));
      if (currentSession() !== current) return;
      if (order.channel !== payload.channel || order.externalReference !== payload.externalReference
        || Date.parse(order.scheduledAt) !== Date.parse(payload.scheduledAt)
        || JSON.stringify(order.lines) !== JSON.stringify(payload.lines)) throw new Error('Unexpected delivery order response');
      pendingOrder = null;
      resetForm();
      reportOutcome(order, null, true);
    } catch (error) {
      if (currentSession() !== current || expired(error)) return;
      if (error.code === 'external_reference_conflict') {
        pendingOrder = null;
        showMessage(formProblem, 'This platform reference belongs to a delivery order with different details. Check the original order before saving.');
      } else if (error.code === 'external_channel_unavailable') {
        pendingOrder = null;
        reload.hidden = false;
        showMessage(formProblem, 'This delivery platform is unavailable. Reload the delivery platforms and check your selection.');
      } else if (error.status === 413 && !wasPending) {
        showMessage(formProblem, 'The delivery order is too large to save. Shorten the item or modifier names.');
      } else if (wasPending || error.status === undefined || error.status >= 500 || error.status === 408) {
        pendingOrder = payload;
        showMessage(formProblem, 'Saving could not be confirmed. Retry this same delivery order before making changes.');
      } else showMessage(formProblem, messageFor(error));
    } finally {
      if (currentSession() === current) {
        saving = false;
        syncForm();
      }
    }
  }

  function syncTransitions() {
    const uncertain = [...pendingTransitions.values()].some(({ uncertain }) => uncertain);
    showMessage(pendingNotice, uncertain ? 'A delivery order update could not be confirmed. Select Refresh to check the server before proceeding.' : '');
    syncQueue();
  }

  function reportOutcome(order, wanted, focus) {
    const current = onOrder(order);
    const name = `Delivery order ${order.externalReference}`;
    let message = `${name} is no longer in the active queue.`;
    if (current) {
      message = `${name} is ${labels[current.status]}.`;
      if (current.status === 'collected' && wanted === 'collected') {
        message = current.confirmedByCurrentOperator ? `Handoff for ${current.externalReference} was confirmed by this account.`
          : `${name} was already handed off.`;
      }
    }
    showMessage(notice, message);
    if (focus) notice.focus();
  }

  async function checkTransition(current, entry, focus = false) {
    const { order, wanted } = entry;
    entry.uncertain = false;
    syncTransitions();
    try {
      const updated = readExternalOrder(await request(`/external-orders/${order.id}`, { token: current.accessToken }));
      if (currentSession() !== current) return;
      if (updated.id !== order.id) throw new Error('Unexpected delivery order response');
      pendingTransitions.delete(order.id);
      reportOutcome(updated, wanted, focus);
    } catch (error) {
      if (currentSession() !== current || expired(error)) return;
      entry.uncertain = true;
    } finally {
      if (currentSession() === current) syncTransitions();
    }
  }

  async function transition(order, wanted, card, input) {
    const current = currentSession();
    if (!current || !queueFresh() || !isCurrent(order) || pendingTransitions.has(order.id)) return;
    const problem = card.querySelector('.order-problem');
    if (input && !reference.test(input.value)) {
      input.setAttribute('aria-invalid', 'true');
      showMessage(problem, 'Enter the exact external reference from the delivery platform.');
      input.focus();
      return;
    }

    const body = { status: wanted, ...(input ? { externalReference: input.value } : {}) };
    const focus = card.contains(document.activeElement) || wanted === 'cancelled';
    const entry = { order, wanted, uncertain: false };
    pendingTransitions.set(order.id, entry);
    showMessage(problem);
    showMessage(notice);
    syncTransitions();
    try {
      const updated = readExternalOrder(await request(`/external-orders/${order.id}/status`, {
        token: current.accessToken, method: 'POST', body,
      }));
      if (currentSession() !== current) return;
      if (updated.id !== order.id || updated.status !== wanted) throw new Error('Unexpected delivery order response');
      pendingTransitions.delete(order.id);
      reportOutcome(updated, wanted, focus);
    } catch (error) {
      if (currentSession() !== current || expired(error)) return;
      if (error.code === 'external_reference_mismatch') {
        pendingTransitions.delete(order.id);
        showMessage(problem, 'The external reference did not match. Check it on the delivery platform.');
        if (input) {
          input.value = '';
          input.disabled = false;
          input.setAttribute('aria-invalid', 'true');
          input.focus();
        }
      } else if (error.status === undefined || error.status >= 500 || [404, 408, 409].includes(error.status)) {
        if (input) input.value = '';
        await checkTransition(current, entry, focus);
      } else {
        pendingTransitions.delete(order.id);
        showMessage(problem, messageFor(error));
      }
    } finally {
      if (currentSession() === current) syncTransitions();
    }
  }

  function actionButton(label, variant = 'primary') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button button-${variant}`;
    button.textContent = label;
    button.dataset.externalAction = 'true';
    return button;
  }

  function addHandoff(card, order, container) {
    const handoff = document.createElement('form');
    handoff.className = 'pickup-form external-handoff';
    handoff.method = 'post';
    handoff.noValidate = true;
    const field = document.createElement('div');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.id = `external-ref-${order.id}`;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 64;
    input.required = true;
    input.dataset.externalAction = 'true';
    const problem = card.querySelector('.order-problem');
    problem.id = `${input.id}-problem`;
    input.setAttribute('aria-describedby', problem.id);
    label.htmlFor = input.id;
    label.textContent = 'External reference';
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      showMessage(problem);
    });
    const button = actionButton('Confirm handoff');
    button.type = 'submit';
    handoff.addEventListener('submit', (event) => {
      event.preventDefault();
      void transition(order, 'collected', card, input);
    });
    field.append(label, input);
    handoff.append(field, button);
    container.append(handoff);
  }

  function addCardActions(card, order, { role }) {
    const container = card.querySelector('.order-actions');
    if (order.status === 'ready' && role !== 'kitchen') addHandoff(card, order, container);
    if (order.status !== 'ready' && role !== 'pickup') {
      const accepted = order.status === 'accepted';
      const action = actionButton(accepted ? 'Start preparing' : 'Mark ready');
      action.addEventListener('click', () => { void transition(order, accepted ? 'preparing' : 'ready', card); });
      container.append(action);
    }
    if (role === 'manager') {
      const action = actionButton('Cancel delivery order', 'secondary');
      action.classList.add('cancel-order');
      action.setAttribute('aria-haspopup', 'dialog');
      action.addEventListener('click', () => {
        if (!queueFresh() || !isCurrent(order)) return;
        cancellation = { order, card };
        dialogTitle.textContent = `Cancel delivery order ${order.externalReference}?`;
        dialog.showModal();
      });
      container.append(action);
    }
  }

  jump.addEventListener('click', () => {
    if (!canIntake(currentSession())) return;
    panel.hidden = false;
    title.focus();
    if (!channels.length) void loadChannels();
  });
  reload.addEventListener('click', () => { void loadChannels(); });
  addItemButton.addEventListener('click', () => addItem(true));
  form.addEventListener('submit', save);
  form.addEventListener('input', (event) => {
    event.target.removeAttribute('aria-invalid');
    if (!pendingOrder) showMessage(formProblem);
  });
  dialogForm.addEventListener('submit', (event) => {
    if (event.submitter?.value !== 'cancel' || !cancellation) return;
    const { order, card } = cancellation;
    if (queueFresh() && isCurrent(order)) void transition(order, 'cancelled', card);
    else showMessage(notice, 'The delivery order changed. Refresh the queue before cancelling it.');
  });
  dialog.addEventListener('close', () => { cancellation = null; });
  resetForm();

  return {
    show(session) { jump.hidden = !canIntake(session); },
    reset() {
      if (dialog.open) dialog.close();
      cancellation = null;
      jump.hidden = panel.hidden = form.hidden = reload.hidden = true;
      channels = [];
      loading = saving = false;
      pendingOrder = null;
      pendingTransitions.clear();
      channel.replaceChildren();
      resetForm();
      syncForm();
      showMessage(notice);
      showMessage(pendingNotice);
      showMessage(channelStatus);
    },
    addCardActions,
    syncCard(card, order, fresh) {
      const disabled = !fresh || pendingTransitions.has(order.id);
      for (const action of card.querySelectorAll('[data-external-action]')) action.disabled = disabled;
    },
    async checkUnconfirmed() {
      const current = currentSession();
      const entries = [...pendingTransitions.values()].filter(({ uncertain }) => uncertain);
      if (current) await Promise.all(entries.map((entry) => checkTransition(current, entry)));
    },
  };
}
