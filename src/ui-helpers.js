export function soundButtonLabel(soundMuted) {
  return soundMuted ? "提示音 关" : "提示音 开";
}

export function pokerCardView(token) {
  if (!token) return { text: "", red: false };
  const rankToken = token.slice(0, -1);
  const suit = token.slice(-1);
  const suitSymbol = { s: "♠", h: "♥", d: "♦", c: "♣" }[suit] || "";
  const rank = rankToken === "T" ? "10" : rankToken;
  return { text: rank + suitSymbol, red: suit === "h" || suit === "d" };
}

export function formatBb(value) {
  if (value == null) return "0";
  const rounded = Math.round(value * 10) / 10;
  return rounded.toString();
}

export function halfBbAmount(value) {
  return Math.round(Number(value) * 2) / 2;
}
