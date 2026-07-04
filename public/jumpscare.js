"use strict";

/*
 * Local jumpscare on final death: giant dino jaws lunge at the screen with a
 * synthesized roar and a phone buzz. Purely client-side — only the player who
 * died sees (and hears) it. Original canvas art, WebAudio-generated sound.
 */
(() => {
  let busy = false;

  function drawJaws(canvas) {
    const W = (canvas.width = 480);
    const H = (canvas.height = 480);
    const ctx = canvas.getContext("2d");

    // throat: dark red glow fading to black
    const throat = ctx.createRadialGradient(W / 2, H / 2, 30, W / 2, H / 2, W * 0.75);
    throat.addColorStop(0, "#5a0a0a");
    throat.addColorStop(0.45, "#2a0404");
    throat.addColorStop(1, "#000");
    ctx.fillStyle = throat;
    ctx.fillRect(0, 0, W, H);

    // jaws: dark green arcs closing in from top and bottom
    ctx.fillStyle = "#1c3323";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(W, 0);
    ctx.quadraticCurveTo(W / 2, H * 0.38, 0, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(W, H);
    ctx.quadraticCurveTo(W / 2, H * 0.62, 0, H);
    ctx.fill();

    // teeth: jagged triangles along each jaw
    const teeth = (baseY, dir, count, len) => {
      ctx.fillStyle = "#f2ede0";
      for (let i = 0; i < count; i++) {
        const x0 = (i / count) * W;
        const x1 = ((i + 1) / count) * W;
        const mid = (x0 + x1) / 2;
        const curve = Math.sin((mid / W) * Math.PI); // deeper bite mid-screen
        const y0 = baseY + dir * curve * 60;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y0);
        ctx.lineTo(mid, y0 + dir * (len + curve * 46));
        ctx.closePath();
        ctx.fill();
      }
    };
    teeth(H * 0.09, 1, 9, 70);
    teeth(H * 0.91, -1, 9, 70);

    // eyes: glowing red, just above the upper jaw line
    for (const ex of [W * 0.3, W * 0.7]) {
      const glow = ctx.createRadialGradient(ex, H * 0.1, 2, ex, H * 0.1, 42);
      glow.addColorStop(0, "#ff4a3d");
      glow.addColorStop(0.35, "#a00d0d");
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(ex, H * 0.1, 42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#180000";
      ctx.beginPath();
      ctx.ellipse(ex, H * 0.1, 5, 14, 0, 0, Math.PI * 2); // slit pupil
      ctx.fill();
    }
  }

  function roar() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const t = ac.currentTime;
      const dur = 0.75;

      // breathy blast: shaped noise through a lowpass
      const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 1.4);
      }
      const noise = ac.createBufferSource();
      noise.buffer = buf;
      const lp = ac.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 850;
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0.55, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
      noise.connect(lp).connect(ng).connect(ac.destination);

      // growl: falling sawtooth
      const osc = ac.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(170, t);
      osc.frequency.exponentialRampToValueAtTime(48, t + dur);
      const og = ac.createGain();
      og.gain.setValueAtTime(0.4, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(og).connect(ac.destination);

      noise.start(t);
      osc.start(t);
      noise.stop(t + dur);
      osc.stop(t + dur);
      setTimeout(() => ac.close().catch(() => {}), (dur + 0.3) * 1000);
    } catch { /* no audio — the visual still lands */ }
  }

  window.playJumpscare = () => {
    if (busy) return;
    busy = true;

    const overlay = document.createElement("div");
    overlay.id = "jumpscare";
    const canvas = document.createElement("canvas");
    overlay.appendChild(canvas);
    document.body.appendChild(overlay);
    drawJaws(canvas);
    roar();
    if (navigator.vibrate) navigator.vibrate([90, 40, 180]);

    setTimeout(() => {
      overlay.remove();
      busy = false;
    }, 900);
  };
})();
