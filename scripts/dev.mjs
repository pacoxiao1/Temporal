import { connect } from "node:net";
import { spawn, spawnSync } from "node:child_process";

// `npm run demo` passes --demo: reply windows run fast (1 minute = 1 second).
// Set here rather than in package.json so it works the same on Windows, macOS and Linux.
if (process.argv.includes("--demo")) process.env.DEMO_SPEED = "on";
const demo = ["on", "true", "1"].includes((process.env.DEMO_SPEED ?? "").toLowerCase());

const compose = spawnSync("docker", ["compose", "up", "-d", "temporal"], {
  stdio: "inherit",
});
if (compose.status !== 0) {
  console.error("\nCould not start Temporal. Is Docker Desktop running?");
  process.exit(compose.status ?? 1);
}

async function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Temporal did not become ready on port ${port}.`);
}

await waitForPort(7233);
// On Windows, npm is a .cmd shim that spawn() can only start through a shell.
const runScript = (name) =>
  process.platform === "win32"
    ? spawn(`npm run ${name}`, { stdio: "inherit", shell: true })
    : spawn("npm", ["run", name], { stdio: "inherit" });
const children = [runScript("dev:worker"), runScript("dev:api")];
let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(exitCode);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const child of children) {
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`A development process stopped (${signal ?? code}).`);
      shutdown(code ?? 1);
    }
  });
}
console.log("\nJuniper Salon waitlist is launching:");
console.log("  App:         http://localhost:3000");
console.log("  Temporal UI: http://localhost:8233");
console.log(
  demo
    ? "  Mode:        DEMO (1 minute = 1 second; a same-day offer times out after 15 s)\n"
    : "  Mode:        NORMAL (real minutes; a same-day offer is held for 15 minutes)\n",
);

