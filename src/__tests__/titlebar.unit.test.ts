import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTitleBase, readTitlebarIntervalMs } from "../features/titlebar.ts";

void describe("readTitlebarIntervalMs", () => {
    const key = "PI_SPINNER_INTERVAL_MS";
    const original = process.env[key];

    void it("defaults to 2000ms (aligned with slow-spinner)", () => {
        delete process.env[key];
        assert.equal(readTitlebarIntervalMs(), 2000);
    });

    void it("honors PI_SPINNER_INTERVAL_MS", () => {
        process.env[key] = "5000";
        assert.equal(readTitlebarIntervalMs(), 5000);
    });

    void it("0 restores the legacy 80ms speed", () => {
        process.env[key] = "0";
        assert.equal(readTitlebarIntervalMs(), 80);
    });

    void it("garbage falls back to the default", () => {
        process.env[key] = "fast";
        assert.equal(readTitlebarIntervalMs(), 2000);
    });

    void it("negative values restore the legacy speed", () => {
        process.env[key] = "-5";
        assert.equal(readTitlebarIntervalMs(), 80);
    });

    void it("restores the original env value", () => {
        if (original === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = original;
        }
        assert.ok(true);
    });
});

void describe("getTitleBase", () => {
    void it("returns cwd basename when no session name", () => {
        const pi = {
            getSessionName: () => undefined,
        } as never;
        const originalCwd = process.cwd();
        try {
            process.chdir("/tmp");
            assert.equal(getTitleBase(pi), "π - tmp");
        } finally {
            process.chdir(originalCwd);
        }
    });

    void it("includes session name when set", () => {
        const pi = {
            getSessionName: () => "my-session",
        } as never;
        const originalCwd = process.cwd();
        try {
            process.chdir("/tmp");
            assert.equal(getTitleBase(pi), "π - my-session - tmp");
        } finally {
            process.chdir(originalCwd);
        }
    });
});
