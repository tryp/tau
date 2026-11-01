#!/usr/bin/env node
import fs from "node:fs";
import pathModule from "node:path";

const path = process.argv[2];
const marker = Buffer.from("\n[stage-0 capture truncated at byte cap]\n");
const requested = Number(process.env.PI_TAU_STAGE0_MAX_BYTES ?? 64 * 1024 * 1024);
const cap = Math.max(
    marker.length,
    Number.isSafeInteger(requested) && requested > 0 ? requested : 64 * 1024 * 1024
);
if (!path) process.exit(2);

let fd;
let size = 0;
let truncated = false;
let reason;
let stdoutClosed = false;
process.stdout.on("error", (error) => {
    if (error?.code === "EPIPE") {
        stdoutClosed = true;
        truncated = true;
        reason = "epipe";
    }
});
try {
    fs.mkdirSync(pathModule.dirname(path), { recursive: true });
    fd = fs.openSync(path, "a");
    size = fs.fstatSync(fd).size;
} catch {
    // A capture is auxiliary; never prevent the requested pipeline from running.
}

async function writeStdout(chunk) {
    if (stdoutClosed) return;
    await new Promise((resolve) => {
        process.stdout.write(chunk, (error) => {
            if (error?.code === "EPIPE") {
                stdoutClosed = true;
                truncated = true;
                reason = "epipe";
            }
            resolve();
        });
    });
}

try {
    for await (const chunk of process.stdin) {
        if (fd !== undefined && !stdoutClosed && size < cap) {
            const remaining = Math.max(0, cap - marker.length - size);
            const keep = Math.min(remaining, chunk.length);
            if (keep > 0) {
                fs.writeSync(fd, chunk, 0, keep);
                size += keep;
            }
            if (keep < chunk.length) {
                truncated = true;
                reason = "cap";
            }
        } else if (fd !== undefined && !stdoutClosed && chunk.length > 0) {
            truncated = true;
            reason = "cap";
        }
        await writeStdout(chunk);
    }
} catch (error) {
    if (error?.code === "EPIPE") {
        stdoutClosed = true;
        truncated = true;
        reason = "epipe";
    } else {
        throw error;
    }
} finally {
    if (fd !== undefined) {
        if (truncated && reason === "cap" && size + marker.length <= cap) {
            fs.writeSync(fd, marker);
        }
        fs.closeSync(fd);
    }
    try {
        fs.writeFileSync(`${path}.status.json`, JSON.stringify({
            truncated,
            bytesWritten: size,
            reason: truncated ? reason ?? "cap" : null,
        }));
    } catch {
        // Status is auxiliary; the original command remains authoritative.
    }
}
