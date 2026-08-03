export const RANK_VALUE = {
  "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  "J": 11, "Q": 12, "K": 13, "A": 14, "2": 15, "x": 16, "X": 17,
};

const NORMAL_RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];

export function makeDeck() {
  const deck = [];
  for (const r of NORMAL_RANKS) {
    for (let i = 0; i < 4; i++) deck.push(r);
  }
  deck.push("x");
  deck.push("X");
  return deck;
}

export function deal(deck) {
  const hands = [[], [], []];
  for (let i = 0; i < 51; i++) hands[i % 3].push(deck[i]);
  const bottom = deck.slice(51, 54);
  return { hands, bottom };
}

export function sortCards(cards) {
  return cards.slice().sort((a, b) => RANK_VALUE[a] - RANK_VALUE[b]);
}
