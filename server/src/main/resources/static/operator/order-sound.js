const reminderIntervalMs = 20_000;

export function createOrderSound(onChange) {
  let context;
  let tone;
  let state = 'off';
  let allowed = false;
  let starting = false;
  let nextAt = 0;

  function setState(value) {
    state = value;
    onChange(value);
  }

  function pause() {
    if (tone) {
      try { tone.stop(); } catch { /* The oscillator may already have ended. */ }
      tone = undefined;
    }
    if (context?.state === 'running') void context.suspend().catch(() => undefined);
  }

  function close() {
    const previous = context;
    pause();
    context = undefined;
    starting = false;
    nextAt = 0;
    if (previous && previous.state !== 'closed') void previous.close().catch(() => undefined);
  }

  async function resume(audio) {
    if (audio.state === 'running') return;
    let timer;
    try {
      await Promise.race([
        audio.resume(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Sound did not start')), 2000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (audio.state !== 'running') throw new Error('Sound did not start');
  }

  async function enable() {
    if (state === 'on' || state === 'starting') return;
    setState('starting');
    let audio;
    try {
      const Audio = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      audio = context = new Audio();
      await resume(audio);
      if (context !== audio) return;
      if (!allowed) pause();
      setState('on');
    } catch {
      if (context !== audio || state !== 'starting') return;
      close();
      setState('failed');
    }
  }

  function mute() {
    close();
    setState('off');
  }

  async function update(canPlay, now) {
    allowed = canPlay;
    if (!canPlay) {
      nextAt = 0;
      pause();
      return;
    }
    if (state !== 'on' || starting || now < nextAt) return;

    const audio = context;
    starting = true;
    try {
      await resume(audio);
      if (context !== audio || state !== 'on' || !allowed) return;

      const start = audio.currentTime;
      const oscillator = audio.createOscillator();
      const envelope = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(440, start);
      oscillator.frequency.setValueAtTime(554, start + 0.16);
      envelope.gain.setValueAtTime(0, start);
      envelope.gain.linearRampToValueAtTime(0.12, start + 0.04);
      envelope.gain.linearRampToValueAtTime(0, start + 0.34);
      oscillator.connect(envelope);
      envelope.connect(audio.destination);
      oscillator.onended = () => {
        oscillator.disconnect();
        envelope.disconnect();
        if (tone === oscillator) tone = undefined;
      };
      oscillator.start(start);
      oscillator.stop(start + 0.35);
      tone = oscillator;
      nextAt = now + reminderIntervalMs;
    } catch {
      if (context === audio && allowed) {
        close();
        setState('failed');
      }
    } finally {
      if (context === audio) {
        starting = false;
        if (!allowed) pause();
      }
    }
  }

  return { enable, mute, update };
}
