// game.js
// The actual UNO rules engine. One Room instance = one game in progress.

const { buildDeck, shuffle } = require("./deck");

const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;

class Room {
  constructor(code, hostName, rules) {
    this.code = code;
    this.players = []; // { id, socketId, name, hand: [], connected: bool }
    this.deck = [];
    this.discard = [];
    this.currentColor = null;
    this.currentIndex = 0;
    this.direction = 1; // 1 = clockwise (in join order), -1 = reverse
    this.drawStack = 0; // pending +2/+4 to be resolved (stacking rule)
    this.started = false;
    this.winner = null;
    this.unoCalled = {}; // playerId -> bool, true once they've called UNO at 1 card
    this.log = [];
    this.rules = Object.assign(
      {
        sevenORule: false, // 7 = swap hands, 0 = rotate all hands
        stacking: false, // allow stacking +2 on +2, +4 on +4/+2
        jumpIn: false, // play an exact match out of turn
        drawUntilPlayable: false, // must keep drawing until you can play (off = draw one, then pass)
      },
      rules || {}
    );
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
    this.deck = shuffle(buildDeck());
    for (const p of this.players) {
      p.hand = this.draw(7);
    }
    // Flip first colored card to start the discard pile (wilds are reshuffled back in).
    let first = this.deck.pop();
    while (first.type === "wild4" || first.type === "wild") {
      this.deck.unshift(first);
      first = this.deck.pop();
    }
    this.discard = [first];
    this.currentColor = first.color || this.randomColor();
    this.currentIndex = 0;
    this.direction = 1;
    this.started = true;
    this._applyStartCardEffect(first);
  }

  randomColor() {
    const c = ["red", "yellow", "green", "blue"];
    return c[Math.floor(Math.random() * 4)];
  }

  _applyStartCardEffect(card) {
    if (card.type === "reverse") this.direction *= -1;
    if (card.type === "skip") this.currentIndex = this.nextIndex();
    if (card.type === "draw2") this.drawStack = 2;
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
    if (card.type === "wild" || card.type === "wild4") {
      if (this.drawStack > 0 && this.rules.stacking) {
        return card.type === "wild4"; // only wild4 stacks on a draw pile
      }
      return true;
    }
    if (this.drawStack > 0 && this.rules.stacking) {
      // Must match the stacking chain: draw2 on draw2, wild4 on anything drawy
      return card.type === "draw2" || card.type === "wild4";
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
    this.currentColor = card.color || options.chosenColor;
    if ((card.type === "wild" || card.type === "wild4") && !this.currentColor) {
      throw new Error("Must choose a color for a wild card");
    }

    const events = [{ type: "played", playerId, card }];

    // Win check
    if (player.hand.length === 0) {
      this.winner = playerId;
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
      case "draw2": {
        this.currentIndex = this.nextIndex();
        if (this.rules.stacking) {
          this.drawStack += 2;
        } else {
          const victim = this.currentPlayer();
          victim.hand.push(...this.draw(2));
          events.push({ type: "draw", playerId: victim.id, count: 2 });
          this.currentIndex = this.nextIndex();
        }
        break;
      }
      case "wild4": {
        this.currentIndex = this.nextIndex();
        if (this.rules.stacking) {
          this.drawStack += 4;
        } else {
          const victim = this.currentPlayer();
          victim.hand.push(...this.draw(4));
          events.push({ type: "draw", playerId: victim.id, count: 4 });
          this.currentIndex = this.nextIndex();
        }
        break;
      }
      case "wild":
        this.currentIndex = this.nextIndex();
        break;
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

    return events;
  }

  drawCard(playerId) {
    const player = this._requirePlayer(playerId);
    if (this.currentPlayer().id !== playerId) throw new Error("Not your turn");
    if (this.winner) throw new Error("Game already over");

    if (this.drawStack > 0) {
      const n = this.drawStack;
      player.hand.push(...this.draw(n));
      this.drawStack = 0;
      this.currentIndex = this.nextIndex();
      return [{ type: "draw", playerId, count: n }, { type: "turnAdvance" }];
    }

    const drawn = this.draw(1);
    player.hand.push(...drawn);
    const events = [{ type: "draw", playerId, count: 1 }];

    if (this.rules.drawUntilPlayable && drawn.length && this.canPlay(drawn[0])) {
      // Player may choose to play it immediately (client prompts); turn does not advance yet.
      events.push({ type: "canPlayDrawn", card: drawn[0] });
    } else {
      this.currentIndex = this.nextIndex();
      events.push({ type: "turnAdvance" });
    }
    return events;
  }

  passTurn(playerId) {
    if (this.currentPlayer().id !== playerId) throw new Error("Not your turn");
    this.currentIndex = this.nextIndex();
    return [{ type: "turnAdvance" }];
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