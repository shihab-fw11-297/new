import { execFileSync } from "node:child_process";
import { realpathSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

const port = Number.parseInt(process.argv[2] ?? "", 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("Usage: node scripts/release-next-port.mjs <port>");
  process.exit(1);
}

const projectDirectory = realpathSync(process.cwd());

function listeningPids() {
  try {
    const output =
      process.platform === "linux"
        ? execFileSync("fuser", ["-n", "tcp", String(port)], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          })
        : execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });

    return [...new Set(output.trim().split(/\s+/).filter(Boolean).map(Number))];
  } catch {
    return [];
  }
}

function processDetails(pid) {
  try {
    const directory = realpathSync(readlinkSync(`/proc/${pid}/cwd`));
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    return { directory, command };
  } catch {
    // macOS does not expose /proc, so fall back to lsof/ps.
    try {
      const cwdOutput = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const directory = realpathSync(
        cwdOutput
          .split("\n")
          .find((line) => line.startsWith("n"))
          ?.slice(1) ?? "",
      );
      const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      });
      return { directory, command };
    } catch {
      return null;
    }
  }
}

const pids = listeningPids();

for (const pid of pids) {
  const details = processDetails(pid);
  const isThisProject = details?.directory === projectDirectory;
  const isNextServer = /(?:next-server|next\s+(?:dev|start))/.test(details?.command ?? "");

  if (!isThisProject || !isNextServer) {
    console.error(
      `Port ${port} is occupied by PID ${pid}, but it is not a Next.js server from ${resolve(projectDirectory)}.`,
    );
    console.error("Stop that process or choose another port; it was left untouched.");
    process.exit(1);
  }

  console.log(`Stopping the existing project server on port ${port} (PID ${pid})...`);
  process.kill(pid, "SIGTERM");
}

if (pids.length > 0) {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline && listeningPids().length > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  if (listeningPids().length > 0) {
    console.error(`The existing server did not release port ${port} within 5 seconds.`);
    process.exit(1);
  }
}
