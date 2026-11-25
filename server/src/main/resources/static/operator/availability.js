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

  let snapshot = null;
  let busy = false;
  let verified = false;

  function syncButtons() {
    refresh.disabled = busy;
    storeToggle.disabled = busy || !verified;
    list.querySelectorAll('button').forEach((button) => { button.disabled = busy || !verified; });
  }

  function render() {
    store.hidden = snapshot === null;
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

  function accept(data) {
    if (!data || typeof data.version !== 'string' || !data.version || typeof data.open !== 'boolean'
      || !Array.isArray(data.products) || data.products.some((product) => !product || typeof product.sku !== 'string'
        || !product.sku || typeof product.name?.en !== 'string' || !product.name.en || typeof product.available !== 'boolean')) {
      throw new Error('Invalid availability response');
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

  async function update(change, notice) {
    const session = currentSession();
    if (session?.role !== 'manager' || busy || !verified || !snapshot) return;

    busy = true;
    syncButtons();
    showMessage(problem);
    showMessage(note);
    let saved = false;
    try {
      const data = await request('/availability', {
        method: 'PATCH', token: session.accessToken, body: { expectedVersion: snapshot.version, ...change },
      });
      if (currentSession() !== session) return;
      accept(data);
      saved = true;
      showMessage(note, notice);
    } catch (error) {
      if (currentSession() !== session) return;
      verified = false;
      if (error.code === 'catalog_version_conflict') {
        showMessage(problem, 'Availability changed. Refresh the menu and review it before trying again.');
      } else {
        report(error);
      }
    } finally {
      if (currentSession() === session) {
        busy = false;
        syncButtons();
        if (saved) {
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
      showMessage(problem);
      showMessage(note);
      render();
    },
  };
}
