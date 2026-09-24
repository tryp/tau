/**
 * Unit tests for the tmux window-liveness sampling cadence.
 *
 * The cadence decides how long a job whose window died without writing its
 * exit-code sentinel keeps reporting "running". It is env-overridable so tests
 * can sample every poll, which makes it easy to misconfigure into a value that
 * never samples at all — hence the sanitizing checks below.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    MAX_TMUX_LIVENESS_POLL_EVERY,
    TMUX_LIVENESS_POLL_EVERY,
    resolveLivenessPollEvery,
} from "../features/bash-tmux.ts";

void describe("tmux liveness poll cadence", () => {
    void it("defaults when unset", () => {
        assert.equal(resolveLivenessPollEvery({}), TMUX_LIVENESS_POLL_EVERY);
    });

    void it("accepts an explicit positive integer", () => {
        assert.equal(
            resolveLivenessPollEvery({
                PI_TAU_TMUX_LIVENESS_POLL_EVERY: "1",
            }),
            1
        );
        assert.equal(
            resolveLivenessPollEvery({
                PI_TAU_TMUX_LIVENESS_POLL_EVERY: " 7 ",
            }),
            7
        );
    });

    void it("clamps a huge value instead of disabling liveness detection", () => {
        // An unclamped 1e308 would push the first sample past any realistic
        // job lifetime: the phantom-"running" job this exists to clear would
        // never be cleared.
        assert.equal(
            resolveLivenessPollEvery({
                PI_TAU_TMUX_LIVENESS_POLL_EVERY: "1e308",
            }),
            TMUX_LIVENESS_POLL_EVERY,
            "scientific notation is not a valid override"
        );
        assert.equal(
            resolveLivenessPollEvery({
                PI_TAU_TMUX_LIVENESS_POLL_EVERY: "999999999999999999999",
            }),
            TMUX_LIVENESS_POLL_EVERY,
            "an unsafe integer is rejected, not clamped from an overflowed value"
        );
        assert.equal(
            resolveLivenessPollEvery({
                PI_TAU_TMUX_LIVENESS_POLL_EVERY: String(
                    MAX_TMUX_LIVENESS_POLL_EVERY + 1
                ),
            }),
            MAX_TMUX_LIVENESS_POLL_EVERY
        );
    });

    void it("rejects values that would busy-loop or mean nothing", () => {
        for (const raw of ["0", "-1", "20.5", "abc", "", " "]) {
            assert.equal(
                resolveLivenessPollEvery({
                    PI_TAU_TMUX_LIVENESS_POLL_EVERY: raw,
                }),
                TMUX_LIVENESS_POLL_EVERY,
                `override ${JSON.stringify(raw)} must fall back to the default`
            );
        }
    });
});
