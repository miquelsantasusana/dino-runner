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
  }

  // -- connection state -------------------------------------------------------
  let ws = null;
  let you = null;
  let hostId = null;
  let roomCode = null;
  let stateTimer = null;

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
      if (roomCode) {
        roomCode = null;
        game.toIdle();
        show("menu");
        setError("Connection lost");
      }
    };
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
        applyLobby(m);
        show("lobby");
        setError("");
        break;

      case "lobby":
        applyLobby(m);
        break;

      case "error":
        setError(m.msg);
        show("menu");
        break;

      case "start":
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
      li.appendChild(document.createTextNode(p.name + (p.id === m.hostId ? " (host)" : "") + (p.id === you ? " — you" : "")));
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
    connect(() => send({ t: "create", name: getName(), avatar: getAvatar() }));
  });

  $("#btn-join").addEventListener("click", () => {
    const code = $("#join-code").value.trim().toUpperCase();
    if (code.length !== 4) return setError("Enter the 4-letter room code");
    connect(() => send({ t: "join", code, name: getName(), avatar: getAvatar() }));
  });

  $("#join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-join").click();
  });

  $("#btn-start").addEventListener("click", () => send({ t: "start" }));
  $("#btn-rematch").addEventListener("click", () => send({ t: "rematch" }));

  const leave = () => {
    send({ t: "leave" });
    stopStateLoop();
    roomCode = null;
    game.toIdle();
    show("menu");
    setError("");
  };
  $("#btn-leave").addEventListener("click", leave);
  $("#btn-lobby-leave").addEventListener("click", leave);

  // Esc returns to menu from a solo run
  document.addEventListener("keydown", (e) => {
    if (e.code === "Escape" && game.mode === "solo" && game.state !== STATE.IDLE) {
      game.toIdle();
      show("menu");
    }
  });

  // -- boot -----------------------------------------------------------------------
  $("#name").value = localStorage.getItem("dino-name") || "";
  const params = new URLSearchParams(location.search);
  if (params.get("room")) {
    $("#join-code").value = params.get("room").toUpperCase().slice(0, 4);
  }
  show("menu");
})();
