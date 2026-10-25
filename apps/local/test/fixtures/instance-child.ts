import { acquireInstance } from "@nema/local";

const home = process.env.NEMA_TEST_HOME;
if (!home) throw new Error("NEMA_TEST_HOME is required");

try {
  const lease = await acquireInstance(home);
  await lease.publish({ origin: "http://127.0.0.1:4173", createLaunchUrl: () => "http://127.0.0.1:4173/_nema/launch" });
  process.stdout.write(`${JSON.stringify({ state: "ready", home: lease.home, controlOrigin: lease.controlOrigin })}\n`);

  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", async (chunk: string) => {
    input += chunk;
    if (!input.includes("\n")) return;
    const command = input.trim();
    input = "";
    if (command === "close") {
      await lease.close();
      process.stdout.write("closed\n");
      process.exit(0);
    }
    if (command === "crash") process.exit(17);
  });
} catch {
  process.stdout.write("owner-error\n");
  process.exitCode = 2;
}
