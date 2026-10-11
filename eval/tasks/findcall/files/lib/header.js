// header module: the function the task hunts for lives here
export function parseHeader(raw) {
  const first = raw.split("\n")[0];
  return first.split(":")[1]?.trim() ?? null;
}
