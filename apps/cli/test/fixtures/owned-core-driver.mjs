import { spawnOwned } from "../../src/ownedProcess.js";

const guardian = process.argv[2];
const grandchild = 'setInterval(() => process.stdout.write("GRANDCHILD_TICK\\n"), 40)';
const target = `const {spawn}=require("node:child_process");spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:["ignore","inherit","inherit"]});setInterval(()=>process.stdout.write("PARENT_TICK\\n"),40)`;
const owned = await spawnOwned(guardian, process.execPath, ["-e", target], { stdio: "inherit" });
process.stdout.write("CORE_READY\\n");
await owned.closed;
