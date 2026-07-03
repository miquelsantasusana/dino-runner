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
  const SIZE = 96; // stored sticker resolution — keeps the data URL a few KB

  const modal = $("#camera-modal");
  const video = $("#camera-video");
  let stream = null;

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
    const c = document.createElement("canvas");
    c.width = c.height = SIZE;
    const ctx = c.getContext("2d");
    // center square crop, zoomed in a touch and biased up toward the face;
    // mirrored so the sticker matches the mirrored preview people pose with
    const side = Math.min(video.videoWidth, video.videoHeight) / 1.3;
    const sx = (video.videoWidth - side) / 2;
    const sy = Math.max(0, (video.videoHeight - side) / 2 - side * 0.08);
    ctx.translate(SIZE, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, side, side, 0, 0, SIZE, SIZE);
    localStorage.setItem(KEY, c.toDataURL("image/jpeg", 0.85));
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
