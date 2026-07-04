"use strict";

/*
 * Network + UI layer. Talks to server.js over WebSocket and drives the
 * menu / lobby / game-over screens. The game itself lives in game.js.
 */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const game = window.game;
  const STATE = window.STATE;

  const screens = {
    menu: $("#menu"),
    lobby: $("#lobby"),
    over: $("#gameover"),
  };

  function show(name) {
    for (const key of Object.keys(screens)) {
      screens[key].classList.toggle("hidden", key !== name);
    }
    $("#screens").classList.toggle("hidden", !name);
    $("#btn-home").classList.toggle("hidden", !!name); // home only while playing
  }

  // -- connection state -------------------------------------------------------
  let ws = null;
  let you = null;
  let hostId = null;
  let roomCode = null;
  let stateTimer = null;
  let reconnectTimer = null;
  let reconnectDeadline = 0;
  let silentRejoin = false; // suppress errors for speculative rejoin attempts

  // stable per-device identity so the server can hold our seat while the
  // phone is backgrounded (WhatsApp trip) or the tab gets reloaded
  let token = localStorage.getItem("dino-token");
  if (!token) {
    token = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(36).slice(2);
    localStorage.setItem("dino-token", token);
  }

  function getName() {
    const name = $("#name").value.trim() || "anon";
    localStorage.setItem("dino-name", name);
    return name;
  }

  function getAvatar() {
    return localStorage.getItem("dino-avatar") || undefined;
  }

  function faceOrDot(p) {
    if (p.avatar) {
      const img = document.createElement("img");
      img.className = "avatar-chip small";
      img.src = p.avatar;
      img.style.borderColor = p.color;
      return img;
    }
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = p.color;
    return dot;
  }

  function connect(then) {
    if (ws && ws.readyState === WebSocket.OPEN) return then();
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(proto + location.host);
    ws.onopen = then;
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      stopStateLoop();
      if (!roomCode) return;
      // don't drop the room — quietly try to reclaim our seat for a while.
      // only a fresh outage resets the give-up deadline, not every failed retry
      if (!reconnectTimer) {
        if (Date.now() > reconnectDeadline) reconnectDeadline = Date.now() + 3 * 60 * 1000;
        setStatus("Reconnecting…");
        scheduleReconnect(1000);
      }
    };
  }

  function scheduleReconnect(delay) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!roomCode) return;
      if (Date.now() > reconnectDeadline) {
        roomCode = null;
        game.toIdle();
        show("menu");
        setError("Connection lost");
        return;
      }
      connect(() => send({ t: "rejoin", token })); // onclose reschedules on failure
    }, delay);
  }

  function clearReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    setStatus("");
  }

  function setStatus(text) {
    $("#net-status").textContent = text;
    $("#net-status").classList.toggle("hidden", !text);
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function setError(text) {
    $("#menu-error").textContent = text;
  }

  // -- state broadcast ---------------------------------------------------------
  function startStateLoop() {
    stopStateLoop();
    stateTimer = setInterval(() => {
      if (game.state === STATE.RUNNING && !game.dino.dead) {
        send({
          t: "state",
          y: Math.round(game.dino.y * 10) / 10,
          duck: game.dino.ducking,
          score: game.score,
          d: Math.round(game.distance), // course position — lets peers render us in our own time frame
        });
      }
    }, 33); // ~30 Hz
  }

  function stopStateLoop() {
    if (stateTimer) clearInterval(stateTimer);
    stateTimer = null;
  }

  // -- server messages ---------------------------------------------------------
  function onMessage(m) {
    switch (m.t) {
      case "joined":
        you = m.you;
        silentRejoin = false;
        clearReconnect();
        applyLobby(m);
        if (m.phase === "playing") setStatus("Race in progress — you'll join the next round");
        show("lobby");
        setError("");
        break;

      case "lobby":
        applyLobby(m);
        break;

      case "error":
        if (silentRejoin) {
          silentRejoin = false; // speculative boot rejoin found nothing — stay quiet
          return;
        }
        clearReconnect();
        roomCode = null;
        setError(m.msg);
        show("menu");
        break;

      case "start":
        setStatus("");
        show(null);
        game.onDeath = (score) => send({ t: "died", score });
        game.startNet(m.seed, m.players, you, m.countdown);
        startStateLoop();
        break;

      case "state":
        game.applyState(m.id, m);
        break;

      case "died":
        game.applyDeath(m.id, m.score);
        break;

      case "over":
        stopStateLoop();
        game.freezeNet();
        renderStandings(m);
        show("over");
        break;
    }
  }

  function applyLobby(m) {
    roomCode = m.code;
    hostId = m.hostId;
    $("#room-code").textContent = m.code;
    const link = `${location.origin}/?room=${m.code}`;
    $("#room-link").textContent = link;
    $("#room-link").href = link;

    const list = $("#player-list");
    list.innerHTML = "";
    for (const p of m.players) {
      const li = document.createElement("li");
      li.appendChild(faceOrDot(p));
      let label = p.name + (p.id === m.hostId ? " (host)" : "") + (p.id === you ? " — you" : "");
      if (p.connected === false) {
        label += " (away)";
        li.classList.add("away");
      }
      li.appendChild(document.createTextNode(label));
      list.appendChild(li);
    }

    const isHost = you === hostId;
    $("#btn-start").classList.toggle("hidden", !isHost);
    $("#lobby-wait").classList.toggle("hidden", isHost);
    $("#btn-rematch").classList.toggle("hidden", !isHost);
    $("#rematch-wait").classList.toggle("hidden", isHost);
  }

  function renderStandings(m) {
    const winner = m.standings.find((p) => p.id === m.winnerId);
    const line = $("#winner-line");
    if (winner) {
      line.textContent = winner.id === you ? "You win! 🏆" : `${winner.name} wins!`;
      line.style.color = winner.color;
    } else {
      line.textContent = "Race over";
      line.style.color = "";
    }
    const list = $("#standings");
    list.innerHTML = "";
    m.standings.forEach((p, i) => {
      const li = document.createElement("li");
      li.appendChild(faceOrDot(p));
      li.appendChild(document.createTextNode(`${p.name} — ${String(p.score).padStart(5, "0")}`));
      if (i === 0) li.classList.add("winner");
      list.appendChild(li);
    });
  }

  // -- buttons -------------------------------------------------------------------
  $("#btn-solo").addEventListener("click", () => {
    getName();
    show(null);
    game.startSolo();
  });

  $("#btn-create").addEventListener("click", () => {
    connect(() => send({ t: "create", name: getName(), avatar: getAvatar(), token }));
  });

  $("#btn-join").addEventListener("click", () => {
    const code = $("#join-code").value.trim().toUpperCase();
    if (code.length !== 4) return setError("Enter the 4-letter room code");
    connect(() => send({ t: "join", code, name: getName(), avatar: getAvatar(), token }));
  });

  $("#join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-join").click();
  });

  $("#btn-start").addEventListener("click", () => send({ t: "start" }));
  $("#btn-rematch").addEventListener("click", () => send({ t: "rematch" }));

  const leave = () => {
    send({ t: "leave" });
    stopStateLoop();
    clearReconnect();
    roomCode = null;
    game.toIdle();
    show("menu");
    setError("");
  };
  $("#btn-leave").addEventListener("click", leave);
  $("#btn-lobby-leave").addEventListener("click", leave);

  // home button (mobile has no Esc): leaves the room in net mode
  $("#btn-home").addEventListener("click", () => {
    if (game.mode === "net") {
      leave();
    } else {
      game.toIdle();
      show("menu");
    }
  });

  // Esc returns to menu from a solo run
  document.addEventListener("keydown", (e) => {
    if (e.code === "Escape" && game.mode === "solo" && game.state !== STATE.IDLE) {
      game.toIdle();
      show("menu");
    }
  });

  // coming back from another app: reclaim the seat right away if the socket died
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && roomCode && (!ws || ws.readyState !== WebSocket.OPEN)) {
      reconnectDeadline = Date.now() + 3 * 60 * 1000;
      scheduleReconnect(50);
    }
  });

  // -- boot -----------------------------------------------------------------------
  $("#name").value = localStorage.getItem("dino-name") || "";
  const params = new URLSearchParams(location.search);
  if (params.get("room")) {
    $("#join-code").value = params.get("room").toUpperCase().slice(0, 4);
  }
  show("menu");

  // mobile browsers often reload the tab on return — if the server still holds
  // a seat for this device, silently drop back into that lobby
  silentRejoin = true;
  connect(() => send({ t: "rejoin", token }));
})();
