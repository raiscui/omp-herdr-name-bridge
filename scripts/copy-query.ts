import { querySessions } from "../src/copy-query";
import { object } from "../src/herdr";

try {
	const input = object(JSON.parse(process.argv[2] || ""));
	if ((input.mode !== "availability" && input.mode !== "resolve") || !Array.isArray(input.targets)
		|| (input.mode === "resolve" && input.targets.length !== 1)) throw new Error("Invalid copy query");
	const answers = await querySessions(input.targets, input.mode);
	console.log(JSON.stringify(input.mode === "availability" ? answers.map(answer => answer.kind === "resolved") : answers[0]));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
