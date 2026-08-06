export function soundButtonLabel(soundMuted) {
  return soundMuted ? "提示音 关" : "提示音 开";
}

export function soundModeLabel(mode) {
  if (mode === "off") return "提示音 关";
  if (mode === "all") return "提示音 全部";
  return "提示音 聊天";
}

export function nextSoundMode(mode) {
  if (mode === "chat") return "all";
  if (mode === "all") return "off";
  return "chat";
}

export function shouldNotifySound(mode, messageType, isMine, shouldAlert) {
  if (mode === "off" || !shouldAlert) return false;
  if (messageType === "chat") return !isMine;
  return mode === "all" && messageType === "system";
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
