const socket = io();

let myPlayerId = null;
let roomCode = null;
let latestState = null;
let pendingCardId = null; // card awaiting a color choice or swap target

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
  const rules = {
    sevenORule: $("#rule-seven").checked,
    stacking: $("#rule-stack").checked,
    jumpIn: $("#rule-jump").checked,
    drawUntilPlayable: $("#rule-drawuntil").checked,
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
    if (!res.ok) alert(res.error);
  });
});

$("#btn-back-lobby").addEventListener("click", () => {
  clearSession();
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
  for (const e of events) logEvent(e);
});

socket.on("chat", ({ name, text }) => {
  const el = document.createElement("div");
  el.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`;
  $("#chat-log").appendChild(el);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
});

$("#chat-send").addEventListener("click", sendChat);
$("#chat-text").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
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
    case "rotateHands": text = `Everyone passed their hand!`; break;
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
  if (card.type === "number") return `${card.color} ${card.value}`;
  return `${card.color} ${card.type}`;
}

function cardClass(card) {
  if (card.type === "wild" || card.type === "wild4") return "wildcard";
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
  return `<span>${main}</span>`;
}

function renderGame(state) {
  const me = state.players.find((p) => p.id === myPlayerId);
  if (!me) return;

  // Opponents
  const others = state.players.filter((p) => p.id !== myPlayerId);
  $("#opponents").innerHTML = others
    .map((p) => `
      <div class="opponent ${p.id === state.currentPlayerId ? "active-turn" : ""} ${p.connected ? "" : "disconnected"}">
        <div class="oname">${escapeHtml(p.name)}</div>
        <div class="ocount">${p.handCount} card${p.handCount === 1 ? "" : "s"}</div>
      </div>
    `)
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

  // My hand
  $("#my-name").textContent = me.name + " (you)";
  const hand = me.hand || [];
  $("#hand").innerHTML = hand
    .map((c) => {
      const playable = isMyTurn && canPlayLocally(c, state);
      return `<div class="card ${cardClass(c)} ${playable ? "" : "unplayable"}" data-card-id="${c.id}">${cardInnerHtml(c)}</div>`;
    })
    .join("");

  document.querySelectorAll("#hand .card").forEach((el) => {
    el.addEventListener("click", () => onPlayCardClick(el.dataset.cardId, state));
  });

  $("#btn-pass").classList.toggle("hidden", true);
}

function colorHex(c) {
  return { red: "#e6342b", yellow: "#f2c229", green: "#2fa84f", blue: "#2b6fe6" }[c] || "#888";
}

// Best-effort local playability check so unplayable cards are visibly dimmed.
// The server is the source of truth and re-validates every move.
function canPlayLocally(card, state) {
  if (card.type === "wild" || card.type === "wild4") {
    if (state.drawStack > 0 && state.rules.stacking) return card.type === "wild4";
    return true;
  }
  if (state.drawStack > 0 && state.rules.stacking) {
    return card.type === "draw2" || card.type === "wild4";
  }
  const top = state.topCard;
  if (card.color === state.currentColor) return true;
  if (card.type === "number" && top.type === "number") return card.value === top.value;
  if (card.type !== "number" && card.type === top.type) return true;
  return false;
}

// ---------- Playing a card ----------
$("#deck-pile").addEventListener("click", () => {
  socket.emit("drawCard", {}, (res) => {
    if (!res.ok) alert(res.error);
  });
});

function onPlayCardClick(cardId, state) {
  const isMyTurn = state.currentPlayerId === myPlayerId;
  const me = state.players.find((p) => p.id === myPlayerId);
  const card = (me.hand || []).find((c) => c.id === cardId);
  if (!card) return;
  if (!isMyTurn && !state.rules.jumpIn) return;

  if (card.type === "wild" || card.type === "wild4") {
    pendingCardId = cardId;
    $("#color-modal").classList.remove("hidden");
    return;
  }
  if (state.rules.sevenORule && card.type === "number" && card.value === 7 && state.players.length > 1) {
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
    submitPlay(pendingCardId, { chosenColor: btn.dataset.color });
  });
});

function submitPlay(cardId, options) {
  const me = latestState.players.find((p) => p.id === myPlayerId);
  const calledUno = me.hand.length === 2; // about to have exactly 1 left
  socket.emit("playCard", { cardId, ...options, calledUno: calledUno && unoArmed }, (res) => {
    if (!res.ok) alert(res.error);
    unoArmed = false;
  });
}

// ---------- UNO button ----------
let unoArmed = false;
$("#btn-uno").addEventListener("click", () => {
  unoArmed = true;
  $("#btn-uno").style.filter = "brightness(1.4)";
  setTimeout(() => ($("#btn-uno").style.filter = ""), 400);

  // Also usable to CATCH an opponent sitting at 1 card without having called it.
  const target = (latestState.players || []).find(
    (p) => p.id !== myPlayerId && p.handCount === 1
  );
  if (target) {
    socket.emit("catchUno", { targetId: target.id }, () => {});
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}