// Test double for pi-subagents/required-child-extensions (module-level fixture).
// Each call re-reads MOCK_REGISTRY_LOG so tests can redirect output between runs.
import { appendFileSync } from "node:fs";
const emit = (event, input) => {
	const log = process.env["MOCK_REGISTRY_LOG"];
	if (log) appendFileSync(log, `${JSON.stringify({ event, ...(input ? structuredClone(input) : {}) })}\n`);
};
export function registerRequiredChildExtensions(input) {
	emit("register", input);
	return { dispose() { emit("dispose"); } };
}
