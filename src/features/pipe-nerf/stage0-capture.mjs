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
let totalBytes = 0;
const tailChunks = [];
let tailLength = 0;
let truncated = false;
let capTruncated = false;
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
        totalBytes += chunk.length;
        if (chunk.length > 0) {
            tailChunks.push(chunk);
            tailLength += chunk.length;
            while (tailLength > cap) {
                const excess = tailLength - cap;
                const first = tailChunks[0];
                if (first.length <= excess) {
                    tailChunks.shift();
                    tailLength -= first.length;
                } else {
                    tailChunks[0] = first.subarray(excess);
                    tailLength -= excess;
                }
            }
        }
        if (fd !== undefined && size < cap) {
            const remaining = Math.max(0, cap - marker.length - size);
            const keep = Math.min(remaining, chunk.length);
            if (keep > 0) {
                fs.writeSync(fd, chunk, 0, keep);
                size += keep;
            }
            if (keep < chunk.length) {
                truncated = true;
                capTruncated = true;
                if (reason !== "epipe") reason = "cap";
            }
        } else if (fd !== undefined && chunk.length > 0) {
            truncated = true;
            capTruncated = true;
            if (reason !== "epipe") reason = "cap";
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
        if (capTruncated && size + marker.length <= cap) {
            fs.writeSync(fd, marker);
        }
        fs.closeSync(fd);
    }
    let tail = null;
    if (totalBytes > cap) {
        const tailMarker = Buffer.from(
            "[stage-0 tail capture: earlier bytes omitted]\n"
        );
        const tailBuffer = Buffer.concat(tailChunks, tailLength);
        try {
            fs.writeFileSync(`${path}.tail`, Buffer.concat([tailMarker, tailBuffer]));
            tail = {
                bytes: tailBuffer.length,
                dropped: Math.max(0, totalBytes - size - tailBuffer.length),
            };
        } catch {
            // Tail capture is auxiliary; the head remains authoritative.
        }
    }
    try {
        fs.writeFileSync(
            `${path}.status.json`,
            JSON.stringify({
                truncated,
                bytesWritten: size,
                reason: truncated ? reason ?? "cap" : null,
                tail,
            })
        );
    } catch {
        // Status is auxiliary; the original command remains authoritative.
    }
}
