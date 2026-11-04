/** Restrict the LAN controller to camera input, never arbitrary viewer messages. */
export function validPhoneMessage(text: string): boolean {
  try {
    const message = JSON.parse(text);
    const finite = (x: unknown) => typeof x === "number" && Number.isFinite(x);
    if (message.t === "q")
      return (
        Array.isArray(message.q) &&
        message.q.length === 4 &&
        message.q.every(finite) &&
        Math.abs(Math.hypot(...message.q) - 1) < 0.01
      );
    if (message.t === "lens")
      return finite(message.mm) && message.mm >= 8 && message.mm <= 200;
    if (message.t === "pong")
      return Number.isSafeInteger(message.id) && message.id >= 0;
    if (message.t === "recenter" || message.t === "record" || message.t === "pause") return true;
    if (message.t === "control")
      return (
        typeof message.active === "boolean" &&
        message.input &&
        ["forward", "lateral", "vertical", "yaw", "pitch"].every(
          (key) =>
            finite(message.input[key]) &&
            Math.abs(message.input[key]) <=
              (["yaw", "pitch"].includes(key) ? 1 : 2.5),
        )
      );
    return false;
  } catch {
    return false;
  }
}
