const socket = io();

let myPlayerId = null;
let roomCode = null;
let latestState = null;
let pendingCardId = null; // card awaiting a color choice or swap target
let pendingChosenColor = null;
let pendingPlaySourceRect = null;
let canPassAfterDraw = false;
let infoTimer = null;

const $ = (sel) => document.querySelector(sel);
const show = (id) => document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("hidden", s.id !== id));

// ---------- Lobby: tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    $("#tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ---------- Lobby: create / join ----------
$("#btn-create").addEventListener("click", () => {
  const name = $("#create-name").value.trim() || "Host";
  const stackingModeInput = document.querySelector('input[name="rule-stack-mode"]:checked');
  const rules = {
    sevenORule: $("#rule-seven").checked,
    stackingMode: stackingModeInput ? stackingModeInput.value : "loose",
    jumpIn: $("#rule-jump").checked,
    drawUntilPlayable: $("#rule-drawuntil").checked,
    playAfterDraw: $("#rule-play-after-draw").checked,
    plus8Cards: $("#rule-plus8").checked,
    passNextCard: $("#rule-passnext").checked,
    swapAnyCard: $("#rule-swapany").checked,
  };
  socket.emit("createRoom", { name, rules }, (res) => {
    if (!res.ok) return ($("#lobby-error").textContent = res.error);
    myPlayerId = res.playerId;
    roomCode = res.code;
    saveSession();
    show("screen-waiting");
  });
});

$("#btn-join").addEventListener("click", () => {
  const name = $("#join-name").value.trim() || "Player";
  const code = $("#join-code").value.trim().toUpperCase();
  socket.emit("joinRoom", { code, name }, (res) => {
    if (!res.ok) return ($("#lobby-error").textContent = res.error);
    myPlayerId = res.playerId;
    roomCode = res.code;
    saveSession();
    show("screen-waiting");
  });
});

$("#btn-start").addEventListener("click", () => {
  socket.emit("startGame", {}, (res) => {
    if (!res.ok) showInfo(res.error, "error");
  });
});
$("#btn-pass").addEventListener("click", () => {
  socket.emit("passTurn", {}, (res) => {
    if (!res.ok) showInfo(res.error, "error");
    canPassAfterDraw = false;
  });
});

$("#btn-back-lobby").addEventListener("click", () => {
  clearSession();
  const confetti = $("#confetti-layer");
  if (confetti) confetti.classList.add("hidden");
  location.reload();
});

// ---------- Session persistence (survives page refresh) ----------
function saveSession() {
  sessionStorage.setItem("uno_code", roomCode);
  sessionStorage.setItem("uno_pid", myPlayerId);
}
function clearSession() {
  sessionStorage.removeItem("uno_code");
  sessionStorage.removeItem("uno_pid");
}

function showInfo(text, type = "info", timeoutMs = 2200) {
  const el = $("#game-info");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden", "error", "success", "warn");
  el.classList.add(type);
  if (infoTimer) clearTimeout(infoTimer);
  infoTimer = setTimeout(() => {
    el.classList.add("hidden");
  }, timeoutMs);
}

function setUnoArmed(active) {
  unoArmed = active;
  const btn = $("#btn-uno");
  if (btn) btn.classList.toggle("armed", !!active);
}
(function tryRejoin() {
  const code = sessionStorage.getItem("uno_code");
  const pid = sessionStorage.getItem("uno_pid");
  if (code && pid) {
    socket.emit("rejoin", { code, playerId: pid }, (res) => {
      if (res.ok) {
        roomCode = res.code;
        myPlayerId = res.playerId;
      } else {
        clearSession();
      }
    });
  }
})();

// ---------- Server state ----------
socket.on("state", (state) => {
  latestState = state;
  if (state.currentPlayerId !== myPlayerId) {
    canPassAfterDraw = false;
    setUnoArmed(false);
  }
  if (!state.started) {
    show("screen-waiting");
    $("#wait-code").textContent = state.code;
    $("#wait-players").innerHTML = state.players
      .map((p) => `<li>${escapeHtml(p.name)} ${p.isHost ? "(host)" : ""} ${p.connected ? "" : "— disconnected"}</li>`)
      .join("");
  } else {
    show("screen-game");
    renderGame(state);
  }
});

socket.on("events", (events) => {
  for (const e of events) {
    if ((e.type === "canPlayAfterDraw" || e.type === "canPlayDrawn") && latestState && latestState.currentPlayerId === myPlayerId) {
      canPassAfterDraw = true;
    }
    if (e.type === "turnAdvance") {
      canPassAfterDraw = false;
      setUnoArmed(false);
    }
    logEvent(e);
    animateEvent(e);
  }
});

socket.on("chat", ({ name, text }) => {
  const el = document.createElement("div");
  el.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`;
  $("#chat-log").appendChild(el);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
});

$("#chat-send").addEventListener("click", sendChat);
$("#chat-text").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

window.addEventListener("resize", () => {
  if (latestState && latestState.started) renderGame(latestState);
});
function sendChat() {
  const text = $("#chat-text").value.trim();
  if (!text) return;
  socket.emit("chat", { text });
  $("#chat-text").value = "";
}

function logEvent(e) {
  const state = latestState;
  const nameOf = (id) => (state.players.find((p) => p.id === id) || {}).name || "?";
  let text = "";
  switch (e.type) {
    case "played": text = `${nameOf(e.playerId)} played ${cardLabel(e.card)}`; break;
    case "draw": text = `${nameOf(e.playerId)} drew ${e.count} card(s)`; break;
    case "skip": text = `${nameOf(e.skippedPlayerId)} was skipped`; break;
    case "swap": text = `${nameOf(e.playerId)} swapped hands with ${nameOf(e.withPlayerId)}`; break;
    case "passnext": text = `${nameOf(e.fromPlayerId)} passed hands to ${nameOf(e.toPlayerId)}`; break;
    case "rotateHands": text = `Everyone passed their hand!`; break;
    case "unoCalled": text = `${nameOf(e.playerId)} called UNO!`; break;
    case "win": text = `🎉 ${nameOf(e.playerId)} wins!`; break;
    case "unoCaught": text = `${nameOf(e.targetId)} got caught without calling UNO! +2 cards`; break;
    default: return;
  }
  const div = document.createElement("div");
  div.textContent = text;
  $("#log").appendChild(div);
  $("#log").scrollTop = $("#log").scrollHeight;

  if (e.type === "win") {
    $("#win-text").textContent = nameOf(e.playerId) === myName() ? "You won! 🎉" : `${nameOf(e.playerId)} won the game.`;
    $("#win-modal").classList.remove("hidden");
    startConfettiCelebration();
  }
}

function myName() {
  const me = (latestState.players || []).find((p) => p.id === myPlayerId);
  return me ? me.name : "";
}

// ---------- Rendering ----------
function cardLabel(card) {
  if (card.type === "wild") return "Wild";
  if (card.type === "wild4") return "Wild +4";
  if (card.type === "wild8") return "Wild +8";
  if (card.type === "passnext") return "Pass Next";
  if (card.type === "swapany") return "Swap Hands";
  if (card.type === "number") return `${card.color} ${card.value}`;
  return `${card.color} ${card.type}`;
}

function cardClass(card) {
  if (card.type === "wild" || card.type === "wild4" || card.type === "wild8" || card.type === "passnext" || card.type === "swapany") return "wildcard";
  return card.color;
}

function cardInnerHtml(card) {
  let main = "";
  if (card.type === "number") main = card.value;
  else if (card.type === "skip") main = "⦸";
  else if (card.type === "reverse") main = "⇄";
  else if (card.type === "draw2") main = "+2";
  else if (card.type === "wild") main = "★";
  else if (card.type === "wild4") main = "+4";
  else if (card.type === "wild8") main = "+8";
  else if (card.type === "passnext") main = "⇢";
  else if (card.type === "swapany") main = "↔";
  return `<span>${main}</span>`;
}

function renderGame(state) {
  const me = state.players.find((p) => p.id === myPlayerId);
  if (!me) return;
  const isDesktop = window.innerWidth > 900;
  const handArea = document.querySelector(".hand-area");
  if (handArea) handArea.classList.toggle("my-turn", state.currentPlayerId === myPlayerId);

  // Opponents sit around the table in turn order, starting with the next player.
  const others = orderedOpponents(state.players, myPlayerId);
  const opponentBounds = $("#opponents").getBoundingClientRect();
  const seatPositions = isDesktop ? computeSeatPositions(others.length, opponentBounds) : [];
  $("#opponents").innerHTML = others
    .map((p, idx) => {
      const pos = isDesktop ? seatPositions[idx] : null;
      const style = pos ? `style="left:${pos.left}px;top:${pos.top}px;"` : "";
      return `
      <div class="opponent ${p.id === state.currentPlayerId ? "active-turn" : ""} ${p.connected ? "" : "disconnected"}" data-player-id="${p.id}" ${style}>
        <div class="oname">${escapeHtml(p.name)}</div>
        <div class="ocount">${p.handCount} card${p.handCount === 1 ? "" : "s"}</div>
      </div>
    `;
    })
    .join("");

  // Discard pile
  const top = state.topCard;
  $("#discard-pile").innerHTML = top
    ? `<div class="card ${cardClass(top)}" style="border-color:${colorHex(state.currentColor)}">${cardInnerHtml(top)}</div>`
    : "";

  $("#deck-count").textContent = state.deckCount;

  // Turn indicator
  const currentPlayer = state.players.find((p) => p.id === state.currentPlayerId);
  const isMyTurn = state.currentPlayerId === myPlayerId;
  $("#turn-indicator").textContent = state.drawStack > 0
    ? `Draw pile: +${state.drawStack} — ${isMyTurn ? "your turn" : (currentPlayer ? currentPlayer.name + "'s turn" : "")}`
    : isMyTurn ? "Your turn!" : `${currentPlayer ? currentPlayer.name : "..."}'s turn`;
  if (!isMyTurn && state.rules.jumpIn && hasJumpInCard(me.hand || [], state)) {
    $("#turn-indicator").textContent += " — jump-in ready!";
  }

  // My hand
  $("#my-name").textContent = me.name + " (you)";
  const hand = me.hand || [];
  $("#hand").innerHTML = hand
    .map((c) => {
      const playable = isMyTurn && canPlayLocally(c, state);
      const jumpInReady = !isMyTurn && state.rules.jumpIn && canJumpInLocally(c, state);
      return `<div class="card ${cardClass(c)} ${playable ? "" : "unplayable"} ${jumpInReady ? "jumpin-ready" : ""}" data-card-id="${c.id}">${cardInnerHtml(c)}</div>`;
    })
    .join("");

  document.querySelectorAll("#hand .card").forEach((el) => {
    el.addEventListener("click", () => onPlayCardClick(el.dataset.cardId, state));
  });

  $("#btn-pass").classList.toggle("hidden", !(canPassAfterDraw && isMyTurn));
}

function orderedOpponents(players, myPlayerId) {
  const myIndex = players.findIndex((p) => p.id === myPlayerId);
  if (myIndex === -1) return players.filter((p) => p.id !== myPlayerId);
  return players.slice(myIndex + 1).concat(players.slice(0, myIndex)).filter((p) => p.id !== myPlayerId);
}

function computeSeatPositions(count, bounds) {
  if (!count || !bounds.width || !bounds.height) return [];
  const centerX = bounds.width / 2;

  const layoutByCount = {
    1: { arcDeg: 0, yCenter: 0.26, rx: 0, ry: 0 },
    2: { arcDeg: 90, yCenter: 0.27, rx: 0.36, ry: 0.26 },
    3: { arcDeg: 120, yCenter: 0.28, rx: 0.4, ry: 0.28 },
    4: { arcDeg: 145, yCenter: 0.29, rx: 0.43, ry: 0.3 },
    5: { arcDeg: 170, yCenter: 0.3, rx: 0.45, ry: 0.32 },
    6: { arcDeg: 190, yCenter: 0.31, rx: 0.47, ry: 0.34 },
    7: { arcDeg: 205, yCenter: 0.31, rx: 0.49, ry: 0.35 },
    8: { arcDeg: 220, yCenter: 0.32, rx: 0.5, ry: 0.36 },
    9: { arcDeg: 230, yCenter: 0.32, rx: 0.51, ry: 0.37 },
  };
  const cfg = layoutByCount[Math.min(count, 9)] || layoutByCount[9];
  const centerY = bounds.height * cfg.yCenter;
  const radiusX = cfg.rx ? Math.max(170, Math.min(bounds.width * cfg.rx, 390)) : 0;
  const radiusY = cfg.ry ? Math.max(120, Math.min(bounds.height * cfg.ry, 280)) : 0;
  const arc = (cfg.arcDeg * Math.PI) / 180;
  const start = -Math.PI / 2 - arc / 2;
  const step = count > 1 ? arc / (count - 1) : 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    const angle = start + step * i;
    out.push({
      left: centerX + Math.cos(angle) * radiusX,
      top: centerY + Math.sin(angle) * radiusY,
    });
  }
  return out;
}

function colorHex(c) {
  return { red: "#e6342b", yellow: "#f2c229", green: "#2fa84f", blue: "#2b6fe6" }[c] || "#888";
}

// Best-effort local playability check so unplayable cards are visibly dimmed.
// The server is the source of truth and re-validates every move.
function canPlayLocally(card, state) {
  const top = state.topCard;
  if (!top) return true;
  const stackingMode = (state.rules && state.rules.stackingMode) || (state.rules && state.rules.stacking ? "loose" : "off");
  if (isWildLikeType(card.type)) {
   if (state.drawStack > 0) {
     if (!isDrawType(card.type) || stackingMode === "off") return false;
     if (stackingMode === "loose") return true;
     return card.type === top.type;
   }
   return true;
  }
  if (state.drawStack > 0) {
   if (!isDrawType(card.type) || stackingMode === "off") return false;
   if (stackingMode === "loose") return true;
   return card.type === top.type;
  }
  if (card.color === state.currentColor) return true;
  if (card.type === "number" && top.type === "number") return card.value === top.value;
  if (card.type !== "number" && card.type === top.type) return true;
  return false;
}

function isDrawType(type) {
  return type === "draw2" || type === "wild4" || type === "wild8";
}

function isWildLikeType(type) {
  return type === "wild" || type === "wild4" || type === "wild8" || type === "passnext" || type === "swapany";
}

function canJumpInLocally(card, state) {
  const top = state.topCard;
  if (!top) return false;
  return card.color === top.color && card.type === top.type && card.value === top.value;
}

function hasJumpInCard(hand, state) {
  return hand.some((card) => canJumpInLocally(card, state));
}

// ---------- Playing a card ----------
$("#deck-pile").addEventListener("click", () => {
  socket.emit("drawCard", {}, (res) => {
    if (!res.ok) showInfo(res.error, "error");
  });
});

function onPlayCardClick(cardId, state) {
  const isMyTurn = state.currentPlayerId === myPlayerId;
  const me = state.players.find((p) => p.id === myPlayerId);
  const card = (me.hand || []).find((c) => c.id === cardId);
  if (!card) return;
  if (!isMyTurn && !state.rules.jumpIn) return;
  pendingChosenColor = null;
  if (!isMyTurn && state.rules.jumpIn && !canJumpInLocally(card, state)) {
    showInfo("Jump-in only works with an identical card.", "warn");
    return;
  }
  if (isMyTurn && !canPlayLocally(card, state)) {
    showInfo("You can't play that card right now.", "warn");
    return;
  }
  rememberPendingPlay(cardId);

  if (isWildLikeType(card.type)) {
    pendingCardId = cardId;
    $("#color-modal").classList.remove("hidden");
    return;
  }
  if (
    ((state.rules.sevenORule && card.type === "number" && card.value === 7) || card.type === "swapany") &&
    state.players.length > 1
  ) {
    pendingCardId = cardId;
    const others = state.players.filter((p) => p.id !== myPlayerId);
    $("#swap-choices").innerHTML = others
      .map((p) => `<button data-target="${p.id}">${escapeHtml(p.name)}</button>`)
      .join("");
    document.querySelectorAll("#swap-choices button").forEach((b) => {
      b.addEventListener("click", () => {
        $("#swap-modal").classList.add("hidden");
        submitPlay(pendingCardId, { swapTargetId: b.dataset.target });
      });
    });
    $("#swap-modal").classList.remove("hidden");
    return;
  }
  submitPlay(cardId, {});
}

document.querySelectorAll(".color-choice").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("#color-modal").classList.add("hidden");
    pendingChosenColor = btn.dataset.color;
    const me = latestState.players.find((p) => p.id === myPlayerId);
    const pendingCard = me && (me.hand || []).find((c) => c.id === pendingCardId);
    if (pendingCard && pendingCard.type === "swapany") {
      const others = latestState.players.filter((p) => p.id !== myPlayerId);
      $("#swap-choices").innerHTML = others
        .map((p) => `<button data-target="${p.id}">${escapeHtml(p.name)}</button>`)
        .join("");
      document.querySelectorAll("#swap-choices button").forEach((b) => {
        b.addEventListener("click", () => {
          $("#swap-modal").classList.add("hidden");
          submitPlay(pendingCardId, { chosenColor: pendingChosenColor, swapTargetId: b.dataset.target });
        });
      });
      $("#swap-modal").classList.remove("hidden");
      return;
    }
    submitPlay(pendingCardId, { chosenColor: pendingChosenColor });
  });
});

function submitPlay(cardId, options) {
  const me = latestState.players.find((p) => p.id === myPlayerId);
  const calledUno = me.hand.length === 2; // about to have exactly 1 left
  socket.emit("playCard", { cardId, ...options, calledUno: calledUno && unoArmed }, (res) => {
    if (!res.ok) {
      showInfo(res.error, "error");
      pendingPlaySourceRect = null;
      pendingCardId = null;
      pendingChosenColor = null;
    } else {
      canPassAfterDraw = false;
      pendingChosenColor = null;
    }
    setUnoArmed(false);
  });
}

function rememberPendingPlay(cardId) {
  const el = document.querySelector(`#hand .card[data-card-id="${cardId}"]`);
  pendingPlaySourceRect = el ? el.getBoundingClientRect() : null;
}

function animateEvent(e) {
  if (!latestState || !latestState.started) return;
  if (!window.requestAnimationFrame) return;

  if (e.type === "played") {
    const sourceRect = e.playerId === myPlayerId && pendingPlaySourceRect
      ? pendingPlaySourceRect
      : getPlayerSeatRect(e.playerId) || $("#deck-pile").getBoundingClientRect();
    const targetRect = $("#discard-pile").getBoundingClientRect();
    animateFlyingCard(e.card, sourceRect, targetRect);
    pendingPlaySourceRect = null;
    pendingCardId = null;
    return;
  }

  if (e.type === "draw") {
    const sourceRect = $("#deck-pile").getBoundingClientRect();
    const targetRect = e.playerId === myPlayerId
      ? getMyHandCardRect()
      : getPlayerSeatRect(e.playerId);
    if (targetRect) animateBackCard(sourceRect, targetRect);
  }
}

function getPlayerSeatRect(playerId) {
  const el = document.querySelector(`.opponent[data-player-id="${playerId}"]`);
  return el ? el.getBoundingClientRect() : null;
}

function getMyHandCardRect() {
  const card = document.querySelector("#hand .card:last-child");
  return card ? card.getBoundingClientRect() : document.querySelector(".hand-area").getBoundingClientRect();
}

function animateFlyingCard(card, fromRect, toRect) {
  if (!fromRect || !toRect) return;
  animateCardElement(buildFxCard(card, false), fromRect, toRect);
}

function animateBackCard(fromRect, toRect) {
  if (!fromRect || !toRect) return;
  animateCardElement(buildFxCard(null, true), fromRect, toRect);
}

function animateCardElement(el, fromRect, toRect) {
  const layer = $("#fx-layer");
  if (!layer) return;
  const layerRect = layer.getBoundingClientRect();
  const fromX = fromRect.left + fromRect.width / 2 - layerRect.left;
  const fromY = fromRect.top + fromRect.height / 2 - layerRect.top;
  const toX = toRect.left + toRect.width / 2 - layerRect.left;
  const toY = toRect.top + toRect.height / 2 - layerRect.top;
  const width = 72;
  const height = 108;

  el.style.left = `${fromX - width / 2}px`;
  el.style.top = `${fromY - height / 2}px`;
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.style.transform = "translate(0, 0) scale(1)";
  layer.appendChild(el);

  requestAnimationFrame(() => {
    el.style.transform = `translate(${toX - fromX}px, ${toY - fromY}px) scale(0.92)`;
    el.style.opacity = "0.15";
  });

  setTimeout(() => {
    el.remove();
  }, 520);
}

function buildFxCard(card, faceDown) {
  const el = document.createElement("div");
  el.className = `fx-card ${faceDown ? "back" : cardClass(card)}`;
  el.innerHTML = faceDown ? "" : cardInnerHtml(card);
  return el;
}

let confettiTimer = null;
function startConfettiCelebration() {
  const layer = $("#confetti-layer");
  if (!layer) return;
  layer.classList.remove("hidden");
  layer.querySelectorAll(".confetti-piece").forEach((piece) => piece.remove());
  const colors = ["#e6342b", "#f2c229", "#2fa84f", "#2b6fe6", "#ffffff"];
  for (let i = 0; i < 140; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = `${2.6 + Math.random() * 2.1}s`;
    piece.style.animationDelay = `${Math.random() * 0.8}s`;
    piece.style.transform = `translateY(-10px) rotate(${Math.random() * 360}deg)`;
    layer.appendChild(piece);
  }
  if (confettiTimer) clearTimeout(confettiTimer);
  confettiTimer = setTimeout(() => {
    layer.classList.add("hidden");
    layer.querySelectorAll(".confetti-piece").forEach((piece) => piece.remove());
  }, 6500);
}

// ---------- UNO button ----------
let unoArmed = false;
$("#btn-uno").addEventListener("click", () => {
  const me = latestState && (latestState.players || []).find((p) => p.id === myPlayerId);
  if (!me) return;

  setUnoArmed(true);
  $("#btn-uno").style.filter = "brightness(1.4)";
  setTimeout(() => ($("#btn-uno").style.filter = ""), 400);

  if (me.handCount === 1) {
    socket.emit("callUno", {}, (res) => {
      if (!res.ok) showInfo(res.error, "warn");
      else showInfo("UNO called!", "success", 1600);
    });
    return;
  }

  if (me.handCount === 2) {
    showInfo("UNO armed for your next play.", "success", 1500);
  }

  // Also usable to catch an opponent sitting at 1 card without having called it.
  const target = (latestState.players || []).find(
    (p) => p.id !== myPlayerId && p.handCount === 1
  );
  if (target) {
    socket.emit("catchUno", { targetId: target.id }, (res) => {
      if (!res.ok) showInfo(res.error, "warn");
      else showInfo(`Caught ${target.name} without UNO!`, "success", 1700);
    });
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}