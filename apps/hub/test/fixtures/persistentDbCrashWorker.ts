import { createLocalDb } from "../../src/db/pglite.js";
import { createWorkspace } from "../../src/workspaces.js";
import { postUserMessage } from "../../src/messages.js";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("expected database directory");

const db = await createLocalDb(dataDir);
const workspace = await createWorkspace(db, dataDir, "crash worker");
await postUserMessage(db, workspace.id, "committed before crash", { authorUserId: "usr_local" });
process.stdout.write("committed\n");
process.exit(73);
