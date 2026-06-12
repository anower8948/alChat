// sounds.js — all alChat sounds are synthesized live with WebAudio.
// No audio files to host, and they have that soft "messaging app" character.
(function () {
  let ctx = null;
  const ac = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());

  function env(gainNode, t0, peak, attack, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(peak, t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  function tone({ freq, type = 'sine', peak = 0.18, attack = 0.005, decay = 0.25, glideTo = null, delay = 0 }) {
    const a = ac();
    const t0 = a.currentTime + delay;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + attack + decay * 0.7);
    env(g, t0, peak, attack, decay);
    osc.connect(g).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.05);
  }

  let ringTimer = null;

  window.Sounds = {
    unlock() { try { ac().resume(); } catch {} },

    // Rising swoosh-pop when you send
    send() {
      tone({ freq: 520, glideTo: 1180, type: 'sine', peak: 0.16, attack: 0.008, decay: 0.18 });
      tone({ freq: 1560, type: 'sine', peak: 0.07, attack: 0.001, decay: 0.09, delay: 0.05 });
    },

    // Soft two-note ding when a message arrives
    receive() {
      tone({ freq: 880, type: 'sine', peak: 0.14, decay: 0.22 });
      tone({ freq: 1318.5, type: 'sine', peak: 0.12, decay: 0.3, delay: 0.09 });
    },

    // Subtle tick for tapback reactions
    tap() {
      tone({ freq: 1900, type: 'triangle', peak: 0.08, attack: 0.001, decay: 0.06 });
    },

    // Classic dual-tone ring pattern, loops until stopped
    startRing(incoming = true) {
      this.stopRing();
      const pattern = () => {
        if (incoming) {
          tone({ freq: 932, type: 'sine', peak: 0.12, decay: 0.5 });
          tone({ freq: 1244, type: 'sine', peak: 0.12, decay: 0.5 });
          tone({ freq: 932, type: 'sine', peak: 0.12, decay: 0.5, delay: 0.65 });
          tone({ freq: 1244, type: 'sine', peak: 0.12, decay: 0.5, delay: 0.65 });
        } else {
          // Outgoing ringback: single soft tone
          tone({ freq: 440, type: 'sine', peak: 0.09, decay: 0.9 });
          tone({ freq: 480, type: 'sine', peak: 0.09, decay: 0.9 });
        }
      };
      pattern();
      ringTimer = setInterval(pattern, incoming ? 2200 : 3000);
    },
    stopRing() {
      if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
    },

    callEnd() {
      tone({ freq: 660, glideTo: 330, type: 'sine', peak: 0.14, decay: 0.35 });
    }
  };

  // Browsers require a user gesture before audio can play
  ['pointerdown', 'keydown'].forEach(ev =>
    document.addEventListener(ev, () => window.Sounds.unlock(), { once: true })
  );
})();
