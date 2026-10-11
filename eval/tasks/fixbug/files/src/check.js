import { slugify } from "./slugs.js";
const cases = [
  ["Hello World 2!", "hello-world-2"],
  ["大桥 speed-test", "speed-test"],
  ["already-fine", "already-fine"],
  ["Trailing DASH ", "trailing-dash"],
];
let bad = 0;
for (const [input, expected] of cases) {
  const got = slugify(input);
  if (got !== expected) { bad++; console.error(`FAIL ${JSON.stringify(input)} → ${got} (want ${expected})`); }
}
process.exit(bad === 0 ? 0 : 1);
