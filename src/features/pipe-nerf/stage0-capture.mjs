#!/usr/bin/env node
import fs from "node:fs";

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
try {
    fd = fs.openSync(path, "a");
    size = fs.fstatSync(fd).size;
} catch {
    // A capture is auxiliary; never prevent the requested pipeline from running.
}

try {
    for await (const chunk of process.stdin) {
        if (fd !== undefined && size < cap) {
            const remaining = Math.max(0, cap - marker.length - size);
            const keep = Math.min(remaining, chunk.length);
            if (keep > 0) {
                fs.writeSync(fd, chunk, 0, keep);
                size += keep;
            }
            if (keep < chunk.length) truncated = true;
        }
        if (!process.stdout.write(chunk)) {
            await new Promise((resolve) => process.stdout.once("drain", resolve));
        }
    }
} finally {
    if (fd !== undefined) {
        if (truncated && size + marker.length <= cap) {
            fs.writeSync(fd, marker);
        }
        fs.closeSync(fd);
    }
}
