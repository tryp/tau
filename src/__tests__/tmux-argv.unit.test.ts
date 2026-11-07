import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    buildSpawnCommand,
    sanitizeTmuxToken,
    tmuxCommandArg,
} from "../tmux.ts";

void describe("tmux argument safety", () => {
    void it("sanitizes shell/tmux metacharacters into a single safe token", () => {
        const input = ";`'\"$()\n\tcommand";
        const result = sanitizeTmuxToken(input);
        assert.match(result, /^[A-Za-z0-9._@:-]+$/);
        assert.equal(result, "_________command");
        assert.equal(result.split(/\s/).length, 1);
    });

    void it("uses deterministic fallbacks for empty, whitespace, and unicode values", () => {
        assert.equal(sanitizeTmuxToken(""), "shell");
        assert.equal(sanitizeTmuxToken(" \n\t "), "shell");
        assert.equal(sanitizeTmuxToken("你好"), "__");
        assert.equal(sanitizeTmuxToken("你好", 30, "bg"), "__");
    });

    void it("preserves a readable prefix and truncates long values to the bound", () => {
        const result = sanitizeTmuxToken(
            "my-long-project-name-that-keeps-going",
            30
        );
        assert.equal(result, "my-long-project-name-that-keep");
        assert.equal(result.length, 30);
    });

    void it("tmux-quotes dynamic path/command arguments without changing their content", () => {
        const value = `/tmp/a b;$(echo 'hi')#\\file`;
        const arg = tmuxCommandArg(value);
        assert.ok(arg.includes(";"));
        assert.ok(arg.includes("\\$"));
        assert.ok(arg.includes("\\#"));
        assert.ok(arg.startsWith("'\""));
        assert.ok(arg.endsWith("\"'"));
    });

    void it("builds a safe command for a shell-assignment first token", () => {
        const command = buildSpawnCommand(
            "i=0; while [ $i -lt 5 ]; do echo $i; done",
            "/tmp/work; dir",
            "/tmp/run; dir/script.sh",
            "pi-bg-example-12345678",
            true
        );
        assert.match(command, /-n 'i_0_'/);
        assert.ok(!command.includes("-n 'i=0;'"));
        assert.ok(
            command.includes("-c '/tmp/work; dir'"),
            "cwd must stay one shell argument for tmux's -c option"
        );
        assert.ok(
            command.includes('"/tmp/run; dir/script.sh"'),
            "script path stays one tmux/shell argument"
        );
        assert.ok(command.includes("-c '"));
    });
});
