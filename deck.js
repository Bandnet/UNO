// deck.js
// This is the "card database": the single source of truth for every
// card that exists in the game and how many copies of it there are.

const COLORS = ["red", "yellow", "green", "blue"];

/**
 * Builds one fresh UNO deck with optional modifier cards.
 * Each card is an object: { id, color, type, value }
 *   type:
 *     "number" | "skip" | "reverse" | "draw2" |
 *     "wild" | "wild4" | "wild8" | "passnext" | "swapany"
 *   value: 0-9 for number cards, null otherwise
 *   color: one of COLORS for colored cards, null for wild/wild4 (until chosen)
 */
function buildDeck(rules = {}) {
  const cards = [];
  let uid = 0;

  const push = (color, type, value = null, copies = 1) => {
    for (let i = 0; i < copies; i++) {
      cards.push({ id: `c${uid++}`, color, type, value });
    }
  };

  for (const color of COLORS) {
    push(color, "number", 0, 1);
    for (let n = 1; n <= 9; n++) push(color, "number", n, 2);
    push(color, "skip", null, 2);
    push(color, "reverse", null, 2);
    push(color, "draw2", null, 2);
  }

  push(null, "wild", null, 4);
  push(null, "wild4", null, 4);
  if (rules.plus8Cards) push(null, "wild8", null, 4);
  if (rules.passNextCard) push(null, "passnext", null, 4);
  if (rules.swapAnyCard) push(null, "swapany", null, 4);

  return cards;
}

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Human-readable label, used server-side for logging only.
function cardLabel(card) {
  if (!card) return "?";
  if (card.type === "wild") return "Wild";
  if (card.type === "wild4") return "Wild Draw Four";
  if (card.type === "wild8") return "Wild Draw Eight";
  if (card.type === "passnext") return "Pass Hand to Next";
  if (card.type === "swapany") return "Swap Hands";
  if (card.type === "number") return `${card.color} ${card.value}`;
  return `${card.color} ${card.type}`;
}

module.exports = { COLORS, buildDeck, shuffle, cardLabel };