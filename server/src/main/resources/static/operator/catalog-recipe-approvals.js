const identifier = /^[A-Za-z0-9._:-]{1,100}$/;
const maxProposalBytes = 12 * 1024 * 1024;
const maxApprovalBytes = 64 * 1024;
const encoder = new TextEncoder();
const kigaliTime = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Africa/Kigali',
});

function isIdentifier(value) {
  return typeof value === 'string' && identifier.test(value);
}

function localized(value) {
  return value && Object.keys(value).length === 2 && [value.en, value.rw].every(text =>
    typeof text === 'string' && text.trim() && !/[\u0000\uD800-\uDFFF]/u.test(text) && [...text].length <= 4096);
}

function readProposal(data, storeId) {
  if (!isIdentifier(data?.store?.id) || !isIdentifier(data.expectedVersion) || !isIdentifier(data.store.version)
    || data.expectedVersion === data.store.version || !Array.isArray(data.products) || !data.products.length) {
    throw new Error('Choose a catalog proposal with a current version, a different new version, and at least one item.');
  }
  if (data.store.id !== storeId) {
    throw new Error('This proposal is for a different store. Choose a proposal for your signed-in store.');
  }
  const seen = new Set();
  const reviews = new Map();
  for (const item of data.products) {
    if (!isIdentifier(item?.sku) || seen.has(item.sku)) {
      throw new Error('Each proposal item needs a unique SKU.');
    }
    seen.add(item.sku);
    // Unchanged entries may omit both revisions. The importer checks that their facts are unchanged.
    if (!Object.hasOwn(item, 'recipeVersion') && !Object.hasOwn(item, 'allergenVersion')) continue;
    if (!localized(item.name) || !isIdentifier(item.recipeVersion) || !isIdentifier(item.allergenVersion)
      || !Array.isArray(item.ingredients) || !item.ingredients.every(localized)
      || !Array.isArray(item.allergens) || !item.allergens.every(localized)) {
      throw new Error('An item for review needs both recipe and allergen revisions and English and Kinyarwanda facts.');
    }
    const body = {
      storeId,
      expectedVersion: data.expectedVersion,
      catalogVersion: data.store.version,
      sku: item.sku,
      crossContactConfirmed: true,
      facts: {
        recipeVersion: item.recipeVersion, allergenVersion: item.allergenVersion,
        ingredients: item.ingredients, allergens: item.allergens,
      },
    };
    if (encoder.encode(JSON.stringify(body)).length > maxApprovalBytes) {
      throw new Error('An item in this proposal exceeds the 64 KiB limit for an individual review.');
    }
    reviews.set(item.sku, { name: item.name, body });
  }
  if (!reviews.size) throw new Error('This proposal has no items with recipe and allergen revisions to review.');
  return { storeId, expectedVersion: data.expectedVersion, catalogVersion: data.store.version, reviews };
}

function renderList(target, rows, empty) {
  if (!rows.length) {
    target.textContent = empty;
    return;
  }
  const list = document.createElement('ul');
  for (const row of rows) {
    const item = document.createElement('li');
    for (const lang of ['en', 'rw']) {
      const text = document.createElement('span');
      text.lang = lang;
      text.textContent = row[lang];
      item.append(text);
    }
    list.append(item);
  }
  target.replaceChildren(list);
}

function receiptMatches(receipt, body) {
  if (!receipt || !['storeId', 'expectedVersion', 'catalogVersion', 'sku'].every(key => receipt[key] === body[key])
    || receipt.recipeVersion !== body.facts.recipeVersion || receipt.allergenVersion !== body.facts.allergenVersion
    || typeof receipt.approvedAt !== 'string' || !Number.isFinite(Date.parse(receipt.approvedAt))) return false;
  return receipt.appliedAt == null || (typeof receipt.appliedAt === 'string'
    && Date.parse(receipt.appliedAt) >= Date.parse(receipt.approvedAt));
}

export function mountCatalogRecipeApprovals({ currentSession, request, messageFor, showMessage, closeSession }) {
  const element = suffix => document.getElementById('recipe-approval' + suffix);
  const panel = element('');
  const jump = element('-jump');
  const form = element('-form');
  const fileInput = element('-file');
  const recheck = element('-recheck');
  const selection = element('-selection');
  const item = element('-item');
  const review = element('-review');
  const confirmation = element('-confirm');
  const submit = element('-submit');
  const problem = element('-problem');
  const status = element('-status');
  const receipts = new Map();
  let proposal;
  let matched = false;
  let operation;

  function selectedReview() {
    return matched ? proposal.reviews.get(item.value) : undefined;
  }

  function syncControls() {
    const busy = !!operation;
    const selected = selectedReview();
    const alreadyApproved = receipts.has(item.value);
    form.setAttribute('aria-busy', String(busy));
    fileInput.disabled = busy;
    recheck.disabled = busy;
    recheck.hidden = !proposal || matched;
    selection.hidden = !matched;
    item.disabled = busy || !matched;
    review.hidden = !selected;
    confirmation.disabled = busy || !selected || alreadyApproved;
    submit.disabled = confirmation.disabled || !confirmation.checked;
  }

  function resetPreview() {
    confirmation.checked = false;
    element('-review-title').textContent = '';
    element('-revisions').textContent = '';
    element('-ingredients').replaceChildren();
    element('-allergens').replaceChildren();
    showMessage(problem);
    showMessage(status);
    syncControls();
  }

  function showReceipt(receipt) {
    const recorded = `Approved ${receipt.sku} for ${receipt.catalogVersion} on ${kigaliTime.format(Date.parse(receipt.approvedAt))} Kigali time.`;
    showMessage(status, receipt.appliedAt
      ? `${recorded} Applied on ${kigaliTime.format(Date.parse(receipt.appliedAt))} Kigali time.`
      : `${recorded} Ready for the catalog importer.`);
  }

  function renderReview() {
    resetPreview();
    const selected = selectedReview();
    if (!selected) return;
    const { name, body: { sku, facts } } = selected;
    element('-review-title').textContent = `${name.en} (${sku})`;
    element('-revisions').textContent = `Recipe revision ${facts.recipeVersion} · Allergen revision ${facts.allergenVersion}`;
    renderList(element('-ingredients'), facts.ingredients, 'No ingredients listed in this proposal.');
    renderList(element('-allergens'), facts.allergens, 'No allergens listed in this proposal.');
    const receipt = receipts.get(sku);
    if (receipt) showReceipt(receipt);
  }

  function resetProposal() {
    proposal = undefined;
    matched = false;
    receipts.clear();
    item.replaceChildren();
    element('-versions').textContent = '';
    resetPreview();
  }

  async function perform(action, onError) {
    const session = currentSession();
    if (session?.role !== 'manager' || panel.hidden || operation) return;
    const controller = new AbortController();
    operation = controller;
    const current = () => operation === controller && currentSession() === session;
    const options = { token: session.accessToken, signal: controller.signal };
    syncControls();
    try {
      await action(session, options, current);
    } catch (error) {
      if (!current()) return;
      if (error?.status === 401) closeSession('Your staff session expired. Sign in again.');
      else onError(error);
    } finally {
      if (current()) {
        operation = undefined;
        syncControls();
      }
    }
  }

  async function matchAvailability(options, current) {
    showMessage(problem);
    showMessage(status, 'Checking the current catalog version…');
    const data = await request('/availability', options);
    if (!current()) return;
    showMessage(status);
    if (!isIdentifier(data?.version)) {
      showMessage(problem, 'The current catalog version could not be confirmed. Check it again.');
      return;
    }
    if (data.version !== proposal.expectedVersion) {
      showMessage(problem, `The current catalog is ${data.version} and the proposal expects ${proposal.expectedVersion}. Choose an updated proposal.`);
      return;
    }
    matched = true;
    element('-versions').textContent = `Store ${proposal.storeId} · Current catalog ${proposal.expectedVersion} · Proposed catalog ${proposal.catalogVersion}`;
    item.replaceChildren(new Option('Select an item', ''));
    for (const [sku, { name }] of proposal.reviews) item.append(new Option(`${name.en} (${sku})`, sku));
    showMessage(status, 'Catalog version checked. Select an item with recipe and allergen revisions to review.');
  }

  function availabilityError(error) {
    showMessage(status);
    showMessage(problem, messageFor(error, 'The current catalog version could not be confirmed. Check it again.'));
  }

  fileInput.addEventListener('change', () => {
    if (operation) return;
    resetProposal();
    const file = fileInput.files[0];
    if (!file) return;
    void perform(async (session, options, current) => {
      let data;
      try {
        if (file.size > maxProposalBytes) throw new Error();
        data = JSON.parse(await file.text());
      } catch {
        if (current()) showMessage(problem, 'Choose a readable JSON catalog proposal up to 12 MiB.');
        return;
      }
      if (!current()) return;
      try {
        proposal = readProposal(data, session.storeId);
      } catch (error) {
        showMessage(problem, error.message);
        return;
      }
      await matchAvailability(options, current);
    }, availabilityError);
  });
  recheck.addEventListener('click', () => {
    if (proposal && !matched) void perform((_session, options, current) => matchAvailability(options, current), availabilityError);
  });
  item.addEventListener('change', renderReview);
  confirmation.addEventListener('change', syncControls);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const selected = selectedReview();
    if (!selected || submit.disabled || !confirmation.checked) return;
    const { body } = selected;
    void perform(async (_session, options, current) => {
      showMessage(problem);
      showMessage(status, 'Saving approval…');
      const receipt = await request('/catalog/recipe-approvals', { ...options, method: 'POST', body });
      if (!current()) return;
      if (!receiptMatches(receipt, body)) {
        showMessage(status);
        showMessage(problem, 'The approval could not be confirmed. Try the same approval again.');
        return;
      }
      confirmation.checked = false;
      receipts.set(body.sku, receipt);
      showReceipt(receipt);
    }, error => {
      showMessage(status);
      if (error?.code === 'catalog_version_conflict') {
        matched = false;
        item.value = '';
        resetPreview();
        showMessage(problem, 'The catalog version changed. Check the current catalog version or choose an updated proposal.');
      } else if (error?.code === 'catalog_recipe_conflict') {
        confirmation.checked = false;
        showMessage(problem, 'An approval exists for this item and catalog with different recipe facts. Review a corrected proposal.');
      } else if (error?.status === 403) {
        showMessage(problem, 'A named manager for this store is required to approve recipes.');
      } else {
        showMessage(problem, messageFor(error, 'The approval could not be confirmed. Try the same approval again.'));
      }
    });
  });
  jump.addEventListener('click', () => {
    if (currentSession()?.role !== 'manager') return;
    panel.hidden = false;
    element('-title').focus();
  });

  return {
    show() { jump.hidden = currentSession()?.role !== 'manager'; },
    reset() {
      operation?.abort();
      operation = undefined;
      form.reset();
      resetProposal();
      jump.hidden = true;
      panel.hidden = true;
    },
  };
}
