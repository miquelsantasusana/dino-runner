"use strict";

/*
 * Face sticker: capture a selfie with the device camera (phone or desktop),
 * crop it to a small square, and store it as a data URL in localStorage.
 * game.js draws it as a round sticker over the dino's head; net.js sends it
 * with create/join so other players see it too.
 */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const KEY = "dino-avatar";
  const SIZE = 112; // stored sticker resolution — keeps the data URL small

  const modal = $("#camera-modal");
  const video = $("#camera-video");
  let stream = null;

  // Cut-out sticker: tight crop on the face, oval mask with a baked-in white
  // sticker edge, transparent corners. Stored as PNG (WebP where supported).
  function makeSticker() {
    const c = document.createElement("canvas");
    c.width = c.height = SIZE;
    const ctx = c.getContext("2d");
    const side = Math.min(video.videoWidth, video.videoHeight) / 1.8; // face-only zoom
    const sx = (video.videoWidth - side) / 2;
    const sy = Math.max(0, (video.videoHeight - side) / 2 - side * 0.12);
    ctx.translate(SIZE, 0);
    ctx.scale(-1, 1); // mirror to match the selfie preview
    ctx.drawImage(video, sx, sy, side, side, 0, 0, SIZE, SIZE);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const oval = (rx, ry) => {
      ctx.beginPath();
      ctx.ellipse(SIZE / 2, SIZE / 2, rx, ry, 0, 0, Math.PI * 2);
    };
    ctx.globalCompositeOperation = "destination-in"; // keep only the oval
    oval(46, 52);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    oval(46, 52);                                    // white sticker edge
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    oval(48.5, 54.5);                                // faint rim for light bg
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.stroke();

    const webp = c.toDataURL("image/webp", 0.85);
    return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/png");
  }

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

  function snap() {
    if (!stream || !video.videoWidth) return;
    localStorage.setItem(KEY, makeSticker());
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
