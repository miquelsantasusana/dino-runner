"use strict";

/*
 * Face sticker: capture a selfie, cut the person out of the background with
 * MediaPipe Selfie Segmentation (lazy-loaded from CDN, runs in-browser), trim
 * to the face, and stamp a white sticker outline around the actual contour.
 * Falls back to an oval crop if segmentation is unavailable or finds nothing.
 * Stored as a small data URL in localStorage; net.js sends it on create/join.
 */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const KEY = "dino-avatar";
  const SIZE = 120;      // final sticker resolution
  const FRAME = 256;     // capture/segmentation working resolution

  const modal = $("#camera-modal");
  const video = $("#camera-video");
  let stream = null;

  // -- MediaPipe loader (lazy, one-time) ------------------------------------
  const MP_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation";
  let segLoad = null;

  function loadSegmenter() {
    if (segLoad) return segLoad;
    segLoad = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = MP_BASE + "/selfie_segmentation.js";
      script.onload = () => {
        try {
          const seg = new SelfieSegmentation({ locateFile: (f) => `${MP_BASE}/${f}` });
          seg.setOptions({ modelSelection: 0 }); // selfie-range model
          resolve(seg);
        } catch {
          resolve(null);
        }
      };
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
    return segLoad;
  }

  function segment(seg, canvas) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 6000);
      seg.onResults((res) => {
        clearTimeout(timer);
        resolve(res);
      });
      seg.send({ image: canvas }).catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  // -- sticker pipeline ------------------------------------------------------
  // capture exactly the square the on-screen guide overlays (the video is
  // object-fit: cover, so what's displayed is the centered min-dimension square)
  function grabFrame() {
    const c = document.createElement("canvas");
    c.width = c.height = FRAME;
    const ctx = c.getContext("2d");
    const side = Math.min(video.videoWidth, video.videoHeight);
    const sx = (video.videoWidth - side) / 2;
    const sy = (video.videoHeight - side) / 2;
    ctx.translate(FRAME, 0);
    ctx.scale(-1, 1); // mirror to match the selfie preview
    ctx.drawImage(video, sx, sy, side, side, 0, 0, FRAME, FRAME);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }

  // person pixels only, soft edge preserved — then intersected with the same
  // oval the on-screen guide shows, so shoulders/neck outside it are dropped
  // and only the face region survives (segmentation trims the background,
  // the oval trims the body)
  function cutOut(frame, mask) {
    const c = document.createElement("canvas");
    c.width = frame.width;
    c.height = frame.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(mask, 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = "source-in";
    ctx.drawImage(frame, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath();
    // matches .cam-ring (inset 8% vertical, 17% horizontal)
    ctx.ellipse(c.width / 2, c.height / 2, c.width * 0.33, c.height * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    return c;
  }

  // bounding box of visible pixels; null if the mask found (nearly) nothing
  function alphaBBox(c) {
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y += 2) {
      for (let x = 0; x < c.width; x += 2) {
        if (data[(y * c.width + x) * 4 + 3] > 40) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0 || maxX - minX < c.width * 0.25 || maxY - minY < c.height * 0.25) return null;
    const pad = Math.round(c.width * 0.04);
    const x = Math.max(0, minX - pad);
    const y = Math.max(0, minY - pad);
    const w = Math.min(c.width, maxX + pad) - x;
    let h = Math.min(c.height, maxY + pad) - y;
    // faces are tall ovals: keep the head (anchored at the top of the person)
    // and drop chest/shoulders if the mask runs down to the frame edge
    h = Math.min(h, w * 1.45);
    return { x, y, w, h };
  }

  // scale the cutout and stamp the white sticker edge (the outline is the
  // cutout's own silhouette drawn at offsets around it). The output canvas
  // keeps the face's natural aspect — tall oval, not a square.
  function finishSticker(cutout, box) {
    const margin = 8; // room for the outline
    const scale = (SIZE - margin * 2) / Math.max(box.w, box.h);
    const w = Math.round(box.w * scale);
    const h = Math.round(box.h * scale);

    const base = document.createElement("canvas");
    base.width = w + margin * 2;
    base.height = h + margin * 2;
    base.getContext("2d").drawImage(cutout, box.x, box.y, box.w, box.h, margin, margin, w, h);

    const sil = document.createElement("canvas");
    sil.width = base.width;
    sil.height = base.height;
    const sctx = sil.getContext("2d");
    sctx.drawImage(base, 0, 0);
    sctx.globalCompositeOperation = "source-in";
    sctx.fillStyle = "#fff";
    sctx.fillRect(0, 0, sil.width, sil.height);

    const out = document.createElement("canvas");
    out.width = base.width;
    out.height = base.height;
    const octx = out.getContext("2d");
    const R = 4;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      octx.drawImage(sil, Math.cos(a) * R, Math.sin(a) * R);
    }
    octx.drawImage(base, 0, 0);
    return out;
  }

  // fallback when segmentation is unavailable: crop exactly the guide oval
  function ovalSticker(frame) {
    const sx = frame.width * 0.17, sy = frame.height * 0.08;
    const sw = frame.width * 0.66, sh = frame.height * 0.84;
    const h = SIZE;
    const w = Math.round(SIZE * (sw / sh)); // keep the guide's tall aspect
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, w, h);
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2 - 3, h / 2 - 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2 - 4, h / 2 - 4, 0, 0, Math.PI * 2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    return c;
  }

  function store(canvas) {
    const webp = canvas.toDataURL("image/webp", 0.85);
    localStorage.setItem(KEY, webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png"));
  }

  // -- UI ---------------------------------------------------------------------
  function refreshPreview() {
    const url = localStorage.getItem(KEY);
    const img = $("#avatar-preview");
    if (url) {
      img.src = url;
      img.classList.remove("hidden");
      $("#btn-avatar-remove").classList.remove("hidden");
      $("#btn-avatar").textContent = "📷 Retake";
    } else {
      img.removeAttribute("src");
      img.classList.add("hidden");
      $("#btn-avatar-remove").classList.add("hidden");
      $("#btn-avatar").textContent = "📷 Add your face";
    }
    if (window.game) window.game.refreshLocalAvatar();
  }

  async function openCamera() {
    $("#camera-error").textContent = "";
    modal.classList.remove("hidden");
    loadSegmenter(); // start fetching the model while the user poses
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      $("#camera-error").textContent = "Camera unavailable (" + err.name + ")";
    }
  }

  function closeCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
    modal.classList.add("hidden");
  }

  async function snap() {
    if (!stream || !video.videoWidth) return;
    const btn = $("#btn-camera-snap");
    btn.disabled = true;
    btn.textContent = "Cutting out…";
    const frame = grabFrame();
    let sticker = null;
    try {
      const seg = await loadSegmenter();
      if (seg) {
        const res = await segment(seg, frame);
        if (res && res.segmentationMask) {
          const cut = cutOut(frame, res.segmentationMask);
          const box = alphaBBox(cut);
          if (box) sticker = finishSticker(cut, box);
        }
      }
    } catch { /* fall through to oval */ }
    if (!sticker) sticker = ovalSticker(frame);
    store(sticker);
    btn.disabled = false;
    btn.textContent = "Capture";
    closeCamera();
    refreshPreview();
  }

  $("#btn-avatar").addEventListener("click", openCamera);
  $("#btn-camera-snap").addEventListener("click", snap);
  $("#btn-camera-cancel").addEventListener("click", closeCamera);
  $("#btn-avatar-remove").addEventListener("click", () => {
    localStorage.removeItem(KEY);
    refreshPreview();
  });

  refreshPreview();
})();
