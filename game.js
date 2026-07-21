// game.js
// The actual UNO rules engine. One Room instance = one game in progress.

const { buildDeck, shuffle } = require("./deck");

const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;

function normalizeStackingMode(rules) {
  if (rules && typeof rules.stackingMode === "string") {
    if (rules.stackingMode === "off" || rules.stackingMode === "loose" || rules.stackingMode === "strict") {
      return rules.stackingMode;
    }
  }
  if (rules && rules.stacking) return "loose";
  return "off";
}

function isDrawCardType(type) {
  return type === "draw2" || type === "wild4" || type === "wild8";
}

function drawValue(type) {
  if (type === "draw2") return 2;
  if (type === "wild4") return 4;
  if (type === "wild8") return 8;
  return 0;
}

function needsChosenColor(type) {
  return type === "wild" || type === "wild4" || type === "wild8" || type === "passnext" || type === "swapany";
}

class Room {
  constructor(code, hostName, rules) {
    this.code = code;
    this.players = []; // { id, socketId, name, hand: [], connected: bool }
    this.deck = [];
    this.discard = [];
    this.currentColor = null;
    this.currentIndex = 0;
    this.direction = 1; // 1 = clockwise (in join order), -1 = reverse
    this.drawStack = 0; // pending draw penalties (+2/+4/+8) to be resolved
    this.started = false;
    this.winner = null;
    this.unoCalled = {}; // playerId -> bool, true once they've called UNO at 1 card
    this.log = [];
    this.rules = Object.assign(
      {
        sevenORule: false, // 7 = swap hands, 0 = rotate all hands
        stackingMode: "off", // off | loose | strict
        stacking: false, // legacy boolean, kept for compatibility
        jumpIn: false, // play an exact match out of turn
        drawUntilPlayable: false, // must keep drawing until you can play (off = draw one, then pass)
        playAfterDraw: false, // after drawing (including +2/+4), you may play instead of auto-pass
        plus8Cards: false, // add 4 wild +8 cards
        passNextCard: false, // add "pass hand to next" cards
        swapAnyCard: false, // add "swap with anyone" cards
      },
      rules || {}
    );
    this.rules.stackingMode = normalizeStackingMode(this.rules);
    this.rules.stacking = this.rules.stackingMode !== "off";
    this.drewThisTurn = false;
    this.addPlayer(hostName, null, true);
  }

  addPlayer(name, socketId, isHost = false) {
    if (this.players.length >= MAX_PLAYERS) throw new Error("Room is full");
    if (this.started) throw new Error("Game already started");
    const id = "p" + Math.random().toString(36).slice(2, 9);
    this.players.push({ id, socketId, name: name.slice(0, 20), hand: [], connected: true, isHost });
    return id;
  }

  removePlayerBySocket(socketId) {
    const p = this.players.find((pl) => pl.socketId === socketId);
    if (p) p.connected = false;
  }

  get playerCount() {
    return this.players.length;
  }

  start() {
    if (this.players.length < MIN_PLAYERS) throw new Error("Need at least 2 players");
    this.deck = shuffle(buildDeck(this.rules));
    for (const p of this.players) {
      p.hand = this.draw(7);
    }
    // Flip first colored card to start the discard pile (wilds are reshuffled back in).
    let first = this.deck.pop();
    while (needsChosenColor(first.type)) {
      this.deck.unshift(first);
      first = this.deck.pop();
    }
    this.discard = [first];
    this.currentColor = first.color || this.randomColor();
    this.currentIndex = 0;
    this.direction = 1;
    this.started = true;
    this.drewThisTurn = false;
    this._applyStartCardEffect(first);
  }

  randomColor() {
    const c = ["red", "yellow", "green", "blue"];
    return c[Math.floor(Math.random() * 4)];
  }

  _applyStartCardEffect(card) {
    if (card.type === "reverse") this.direction *= -1;
    if (card.type === "skip") this.currentIndex = this.nextIndex();
    if (isDrawCardType(card.type)) this.drawStack = drawValue(card.type);
  }

  draw(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) this._reshuffleDiscardIntoDeck();
      if (this.deck.length === 0) break; // truly nothing left
      out.push(this.deck.pop());
    }
    return out;
  }

  _reshuffleDiscardIntoDeck() {
    if (this.discard.length <= 1) return;
    const top = this.discard.pop();
    this.deck = shuffle(this.discard);
    this.discard = [top];
  }

  currentPlayer() {
    return this.players[this.currentIndex];
  }

  nextIndex(from = this.currentIndex, steps = 1) {
    const n = this.players.length;
    let idx = from;
    for (let i = 0; i < steps; i++) {
      idx = (idx + this.direction + n) % n;
    }
    return idx;
  }

  topCard() {
    return this.discard[this.discard.length - 1];
  }

  canPlay(card) {
    const top = this.topCard();
    const stackingMode = this.rules.stackingMode;
    if (needsChosenColor(card.type)) {
      if (this.drawStack > 0 && stackingMode !== "off") {
        if (!isDrawCardType(card.type)) return false;
        if (stackingMode === "loose") return true;
        return card.type === top.type;
      }
      return true;
    }
    if (this.drawStack > 0 && stackingMode !== "off") {
      if (!isDrawCardType(card.type)) return false;
      if (stackingMode === "loose") {
        return true;
      }
      return card.type === top.type;
    }
    if (card.color === this.currentColor) return true;
    if (card.type === "number" && top.type === "number") return card.value === top.value;
    if (card.type !== "number" && card.type === top.type) return true;
    return false;
  }

  /**
   * Play a card. Returns an event log describing what happened, for the
   * server to broadcast. Throws on illegal moves.
   */
  playCard(playerId, cardId, options = {}) {
    const player = this._requirePlayer(playerId);
    if (!this.started) throw new Error("Game hasn't started");
    if (this.winner) throw new Error("Game already over");

    const isMyTurn = this.currentPlayer().id === playerId;
    const cardIdx = player.hand.findIndex((c) => c.id === cardId);
    if (cardIdx === -1) throw new Error("Card not in hand");
    const card = player.hand[cardIdx];
    const chosenColor = card.color || options.chosenColor;

    if (needsChosenColor(card.type) && !chosenColor) {
      throw new Error("Must choose a color for this card");
    }

    if (!isMyTurn) {
      if (!this.rules.jumpIn) throw new Error("Not your turn");
      // Jump-in: only allowed if the card is an EXACT match (color+type+value) to the top card.
      const top = this.topCard();
      const exact = card.color === top.color && card.type === top.type && card.value === top.value;
      if (!exact) throw new Error("Jump-in requires an identical card");
      this.currentIndex = this.players.findIndex((p) => p.id === playerId);
    } else {
      if (!this.canPlay(card)) throw new Error("That card can't be played right now");
    }

    // Remove from hand, place on discard.
    player.hand.splice(cardIdx, 1);
    this.discard.push(card);
    this.currentColor = chosenColor;

    const events = [{ type: "played", playerId, card }];

    // Win check
    if (player.hand.length === 0) {
      this.winner = playerId;
      this.drewThisTurn = false;
      events.push({ type: "win", playerId });
      return events;
    }

    // UNO callout enforcement: if they now have 1 card and didn't call it, they can be caught later.
    if (player.hand.length === 1) this.unoCalled[playerId] = !!options.calledUno;
    else delete this.unoCalled[playerId];

    // Apply card effects
    switch (card.type) {
      case "skip": {
        const skippedIdx = this.nextIndex();
        events.push({ type: "skip", skippedPlayerId: this.players[skippedIdx].id });
        this.currentIndex = this.nextIndex(skippedIdx);
        break;
      }
      case "reverse":
        this.direction *= -1;
        // In a 2-player game, reverse also acts like a skip (same net effect either way).
        this.currentIndex = this.nextIndex();
        break;
      case "draw2":
      case "wild4":
      case "wild8": {
        this.currentIndex = this.nextIndex();
        if (this.rules.stacking) {
          this.drawStack += drawValue(card.type);
        } else {
          const victim = this.currentPlayer();
          victim.hand.push(...this.draw(drawValue(card.type)));
          events.push({ type: "draw", playerId: victim.id, count: drawValue(card.type) });
          this.currentIndex = this.nextIndex();
        }
        break;
      }
      case "wild":
        this.currentIndex = this.nextIndex();
        break;
      case "passnext": {
        const nextIdx = this.nextIndex();
        const nextPlayer = this.players[nextIdx];
        const tmp = nextPlayer.hand;
        nextPlayer.hand = player.hand;
        player.hand = tmp;
        events.push({ type: "passnext", fromPlayerId: playerId, toPlayerId: nextPlayer.id });
        this.currentIndex = this.nextIndex();
        break;
      }
      case "swapany": {
        const targetId = options.swapTargetId;
        const target = this.players.find((p) => p.id === targetId && p.id !== playerId);
        if (!target) throw new Error("Choose a player to swap hands with");
        const tmp = target.hand;
        target.hand = player.hand;
        player.hand = tmp;
        events.push({ type: "swap", withPlayerId: target.id, playerId });
        this.currentIndex = this.nextIndex();
        break;
      }
      case "number":
        if (this.rules.sevenORule && card.value === 7) {
          const targetId = options.swapTargetId;
          const target = this.players.find((p) => p.id === targetId && p.id !== playerId);
          if (target) {
            const tmp = target.hand;
            target.hand = player.hand;
            player.hand = tmp;
            events.push({ type: "swap", withPlayerId: target.id, playerId });
          }
          this.currentIndex = this.nextIndex();
        } else if (this.rules.sevenORule && card.value === 0) {
          // Rotate all hands in the direction of play.
          const hands = this.players.map((p) => p.hand);
          const n = this.players.length;
          for (let i = 0; i < n; i++) {
            const fromIdx = (i - this.direction + n) % n;
            this.players[i].hand = hands[fromIdx];
          }
          events.push({ type: "rotateHands" });
          this.currentIndex = this.nextIndex();
        } else {
          this.currentIndex = this.nextIndex();
        }
        break;
    }

    this.drewThisTurn = false;
    return events;
  }

  drawCard(playerId) {
    const player = this._requirePlayer(playerId);
    if (this.currentPlayer().id !== playerId) throw new Error("Not your turn");
    if (this.winner) throw new Error("Game already over");
    if (this.drawStack === 0 && this.drewThisTurn && !this.rules.drawUntilPlayable) {
      throw new Error("You already drew this turn");
    }

    if (this.drawStack > 0) {
      const n = this.drawStack;
      player.hand.push(...this.draw(n));
      this.drawStack = 0;
      const events = [{ type: "draw", playerId, count: n }];
      if (this.rules.playAfterDraw && this._hasPlayableCard(player)) {
        this.drewThisTurn = true;
        events.push({ type: "canPlayAfterDraw", fromPenalty: true, count: n });
      } else {
        this.currentIndex = this.nextIndex();
        this.drewThisTurn = false;
        events.push({ type: "turnAdvance" });
      }
      return events;
    }

    const drawn = this.draw(1);
    player.hand.push(...drawn);
    const events = [{ type: "draw", playerId, count: 1 }];
    const drawnPlayable = drawn.length && this.canPlay(drawn[0]);
    const canPlayNow = this.rules.playAfterDraw && this._hasPlayableCard(player);
    if ((this.rules.drawUntilPlayable && drawnPlayable) || canPlayNow) {
      this.drewThisTurn = true;
      if (this.rules.drawUntilPlayable && drawnPlayable) {
        // Player may choose to play it immediately (client prompts); turn does not advance yet.
        events.push({ type: "canPlayDrawn", card: drawn[0] });
      }
      if (canPlayNow) {
        events.push({ type: "canPlayAfterDraw", fromPenalty: false, count: 1 });
      }
    } else {
      this.currentIndex = this.nextIndex();
      this.drewThisTurn = false;
      events.push({ type: "turnAdvance" });
    }
    return events;
  }

  passTurn(playerId) {
    if (this.currentPlayer().id !== playerId) throw new Error("Not your turn");
    this.currentIndex = this.nextIndex();
    this.drewThisTurn = false;
    return [{ type: "turnAdvance" }];
  }

  _hasPlayableCard(player) {
    return player.hand.some((card) => this.canPlay(card));
  }

  callUno(playerId) {
    const player = this._requirePlayer(playerId);
    if (this.winner) throw new Error("Game already over");
    if (player.hand.length !== 1) throw new Error("You can only call UNO with exactly 1 card");
    this.unoCalled[playerId] = true;
    return [{ type: "unoCalled", playerId }];
  }

  /** Catch a player who forgot to call UNO at 1 card. They draw 2 as a penalty. */
  catchUno(accuserId, targetId) {
    const target = this._requirePlayer(targetId);
    if (target.hand.length !== 1 || this.unoCalled[targetId]) {
      throw new Error("Nothing to catch");
    }
    target.hand.push(...this.draw(2));
    return [{ type: "unoCaught", targetId, accuserId }];
  }

  _requirePlayer(playerId) {
    const p = this.players.find((pl) => pl.id === playerId);
    if (!p) throw new Error("Unknown player");
    return p;
  }

  /** Public snapshot of state, safe to send to a given viewer (hides other hands). */
  viewFor(playerId) {
    return {
      code: this.code,
      started: this.started,
      winner: this.winner,
      direction: this.direction,
      currentColor: this.currentColor,
      currentPlayerId: this.started ? this.currentPlayer().id : null,
      drawStack: this.drawStack,
      topCard: this.discard.length ? this.topCard() : null,
      deckCount: this.deck.length,
      rules: this.rules,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        handCount: p.hand.length,
        isHost: p.isHost,
        hand: p.id === playerId ? p.hand : undefined,
      })),
    };
  }
}

module.exports = { Room, MAX_PLAYERS, MIN_PLAYERS };