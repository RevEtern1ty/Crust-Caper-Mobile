const alignedTime = /^(?:[01]\d|2[0-3]):[0-5]0$/;
const calendarDate = /^\d{4}-\d{2}-\d{2}$/;
const lostPublication = 'Publication could not be confirmed. Retry the same schedule before making changes.';

function minutes(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function windowCount({ start, end }) {
  return (minutes(end) - minutes(start)) / 10;
}

function windows(count) {
  return `${count} pickup window${count === 1 ? '' : 's'}`;
}

export function mountPickupSchedule({
  currentSession, request, messageFor, showMessage, closeSession, accept, currentAvailability, setBusy, markUnverified,
}) {
  const element = (name) => document.getElementById(`pickup-schedule${name && `-${name}`}`);
  const panel = element('');
  const form = element('form');
  const date = element('date');
  const start = element('start');
  const end = element('end');
  const capacity = element('capacity');
  const review = element('review');
  const problem = element('problem');
  const note = element('note');
  const dialog = element('dialog');
  const summary = element('summary');
  const progress = element('progress');
  const dialogProblem = element('dialog-problem');
  const confirm = element('confirm');
  const edit = element('edit');
  const publish = element('publish');
  const fields = [date, start, end, capacity];

  let pending = null;
  let uncertain = false;

  function sync() {
    const { busy, verified, snapshot } = currentAvailability();
    panel.hidden = !snapshot?.slots && !uncertain;
    form.setAttribute('aria-busy', String(busy));
    fields.forEach((input) => { input.disabled = busy || !verified || uncertain; });
    review.disabled = busy || (!verified && !uncertain);
    review.textContent = uncertain ? 'Review pending publication' : 'Review pickup schedule';
    edit.textContent = uncertain ? 'Close review' : 'Edit schedule';
    edit.disabled = busy;
    publish.textContent = uncertain ? 'Retry publication' : 'Publish windows';
    publish.disabled = busy || !pending;
  }

  function invalid(input, message) {
    input.setAttribute('aria-invalid', 'true');
    showMessage(problem, message);
    input.focus();
    return null;
  }

  function readSchedule() {
    if (!calendarDate.test(date.value) || !date.validity.valid || date.value.startsWith('0000-')) {
      return invalid(date, 'Choose a pickup date in Kigali.');
    }
    if (!alignedTime.test(start.value)) return invalid(start, 'Choose a start time on a ten-minute boundary.');
    if (!alignedTime.test(end.value)) return invalid(end, 'Choose an end time on a ten-minute boundary.');
    if (start.value >= end.value) return invalid(end, 'Choose an end time after the start on the same date.');
    const limit = Number(capacity.value);
    if (!/^\d+$/.test(capacity.value) || !capacity.validity.valid || !Number.isInteger(limit)) {
      return invalid(capacity, 'Enter a whole number of orders from 1 to 2,147,483,647.');
    }
    return { id: crypto.randomUUID(), date: date.value, start: start.value, end: end.value, capacity: limit };
  }

  function showReview() {
    const input = pending.pickupSchedule;
    const count = windowCount(input);
    summary.textContent = `${input.date}, ${input.start}–${input.end} Kigali time. ${windows(count)}, ${input.capacity} ${input.capacity === 1 ? 'order' : 'orders'} per window.`;
    showMessage(problem);
    showMessage(dialogProblem, uncertain ? lostPublication : '');
    showMessage(progress);
    sync();
    dialog.showModal();
  }

  function returnToForm() {
    if (dialog.open) dialog.close();
    if (uncertain) showMessage(problem, lostPublication);
    else pending = null;
    sync();
    review.focus();
  }

  function expiredSession(error) {
    if (error.status !== 401) return false;
    closeSession('Your staff session expired. Sign in again.');
    return true;
  }

  async function refreshSnapshot(session) {
    try {
      const data = await request('/availability', { token: session.accessToken });
      if (currentSession() === session) accept(data);
      return currentSession() === session;
    } catch (error) {
      if (currentSession() === session) expiredSession(error);
      return false;
    }
  }

  function rejection(error) {
    if (error.code === 'pickup_schedule_started') return 'The start time has passed in Kigali. Choose a future time.';
    if (error.code === 'pickup_schedule_overlap') return 'This schedule overlaps an existing pickup window. Review availability and choose different times.';
    if (error.code === 'pickup_schedule_conflict') return 'This publication was already used for a different schedule. Review availability before publishing again.';
    if (error.code === 'catalog_version_conflict') return 'Availability changed. Review the updated schedule before publishing again.';
    return messageFor(error);
  }

  function outcomeUnconfirmed(error) {
    if (error.status === undefined || error.status >= 500 || error.status === 408) return true;
    return uncertain && !(error.status === 409 && [
      'pickup_schedule_started', 'pickup_schedule_overlap', 'pickup_schedule_conflict', 'catalog_version_conflict',
    ].includes(error.code));
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const { busy, verified, snapshot } = currentAvailability();
    if (currentSession()?.role !== 'manager' || busy) return;
    if (!uncertain) {
      if (!verified || !snapshot) return;
      showMessage(problem);
      showMessage(note);
      const pickupSchedule = readSchedule();
      if (!pickupSchedule) return;
      pending = { expectedVersion: snapshot.version, pickupSchedule };
    }
    showReview();
  });

  fields.forEach((input) => input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');
    showMessage(problem);
    showMessage(note);
  }));
  edit.addEventListener('click', returnToForm);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!currentAvailability().busy) returnToForm();
  });

  confirm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = currentSession();
    if (session?.role !== 'manager' || currentAvailability().busy || !dialog.open || !pending) return;

    const publication = pending;
    setBusy(true);
    showMessage(problem);
    showMessage(dialogProblem);
    showMessage(progress, 'Publishing pickup windows…');
    progress.focus();
    try {
      const data = await request('/availability', { method: 'PATCH', token: session.accessToken, body: publication });
      if (currentSession() !== session) return;
      accept(data);
      uncertain = false;
      pending = null;
      dialog.close();
      form.reset();
      showMessage(note, `Published ${windows(windowCount(publication.pickupSchedule))}.`);
      note.focus();
    } catch (error) {
      if (currentSession() !== session || expiredSession(error)) return;
      markUnverified();
      uncertain = outcomeUnconfirmed(error);
      const refreshed = await refreshSnapshot(session);
      if (currentSession() !== session) return;
      if (uncertain) {
        showMessage(dialogProblem, lostPublication);
        dialogProblem.focus();
      } else {
        pending = null;
        dialog.close();
        showMessage(problem, rejection(error) + (refreshed ? '' : ' Refresh availability before trying again.'));
        problem.focus();
      }
    } finally {
      if (currentSession() === session) {
        showMessage(progress);
        setBusy(false);
      }
    }
  });

  return {
    sync,
    reset() {
      pending = null;
      uncertain = false;
      if (dialog.open) dialog.close();
      form.reset();
      fields.forEach((input) => input.removeAttribute('aria-invalid'));
      for (const message of [problem, note, progress, dialogProblem]) showMessage(message);
    },
  };
}
