import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_SHORTCUTS } from "../features/shortcut-keys.ts";

// Enumerated from pi-mono TUI_KEYBINDINGS and coding-agent KEYBINDINGS;
// ctrl+x/ctrl+l are restricted app shortcuts and cannot be overridden.
const piBuiltInKeys = new Set([
    "alt+b", "alt+backspace", "alt+d", "alt+delete", "alt+down", "alt+f",
    "alt+left", "alt+right", "alt+up", "alt+y", "backspace", "ctrl+-",
    "ctrl+a", "ctrl+b", "ctrl+backspace", "ctrl+c", "ctrl+d", "ctrl+down",
    "ctrl+e", "ctrl+end", "ctrl+f", "ctrl+g", "ctrl+home", "ctrl+j",
    "ctrl+k", "ctrl+l", "ctrl+left", "ctrl+n", "ctrl+o", "ctrl+p",
    "ctrl+r", "ctrl+right", "ctrl+s", "ctrl+t", "ctrl+u", "ctrl+up",
    "ctrl+w", "ctrl+x", "ctrl+y", "delete", "down", "end", "enter",
    "escape", "home", "left", "right", "shift+ctrl+o", "shift+enter",
    "shift+l", "shift+t", "shift+tab", "tab", "up",
]);
const piTauShortcuts = [
    BACKGROUND_SHORTCUTS.background,
    BACKGROUND_SHORTCUTS.tasks,
    BACKGROUND_SHORTCUTS.kill,
    BACKGROUND_SHORTCUTS.loop,
    "shift+down",
];

void describe("pi-tau shortcut conflicts", () => {
    void it("registers no duplicate shortcuts", () => {
        assert.equal(new Set(piTauShortcuts).size, piTauShortcuts.length);
    });

    void it("registers no shortcut that collides with a built-in or restricted key", () => {
        for (const shortcut of piTauShortcuts) {
            assert.equal(piBuiltInKeys.has(shortcut), false, `${shortcut} conflicts with pi`);
        }
    });
});
