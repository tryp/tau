import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    classifyIndexError,
    retryIndexOperation,
} from "../features/sidecar-index-errors.ts";

void describe("classifyIndexError", () => {
    const cases: [
        string,
        Parameters<typeof classifyIndexError>[0],
        string,
        boolean,
    ][] = [
        [
            "busy SQLite primary code",
            { code: 5, message: "disk I/O error" },
            "busy",
            true,
        ],
        [
            "busy extended SQLite code",
            { code: 517, message: "locked" },
            "busy",
            true,
        ],
        [
            "locked SQLite code",
            { code: "SQLITE_LOCKED_SHAREDCACHE", message: "unknown" },
            "locked",
            true,
        ],
        [
            "readonly SQLite code",
            { code: 8, message: "unknown" },
            "readonly",
            false,
        ],
        [
            "schema SQLite code",
            { code: 17, message: "unknown" },
            "schema",
            false,
        ],
        ["IOERR SQLite code", { code: 10, message: "unknown" }, "io", false],
        [
            "missing OS code",
            { code: "ENOENT", message: "permission denied" },
            "missing",
            false,
        ],
        [
            "permission OS code",
            { code: "EACCES", message: "unknown" },
            "permission",
            false,
        ],
        [
            "stale message fallback",
            {
                message:
                    "This extension ctx is stale after session replacement or reload",
            },
            "stale",
            false,
        ],
        [
            "schema message fallback",
            { message: "no such table: context_sources" },
            "schema",
            false,
        ],
        [
            "busy message fallback",
            { message: "database is busy" },
            "busy",
            true,
        ],
        [
            "locked message fallback",
            { message: "database is locked" },
            "locked",
            true,
        ],
        [
            "readonly message fallback",
            { message: "attempt to write a readonly database" },
            "readonly",
            false,
        ],
        [
            "permission fallback",
            { message: "permission denied" },
            "permission",
            false,
        ],
        ["I/O fallback", { message: "disk I/O error" }, "io", false],
        [
            "unknown fallback",
            { message: "unexpected failure" },
            "unknown",
            false,
        ],
    ];

    for (const [name, input, category, retryable] of cases) {
        void it(`classifies ${name}`, () => {
            assert.deepEqual(classifyIndexError(input), {
                category,
                retryable,
            });
        });
    }

    void it("retries SQLITE_BUSY once using fake timers", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let attempts = 0;
        const resultPromise = retryIndexOperation(async () => {
            attempts += 1;
            if (attempts === 1) {
                throw Object.assign(new Error("database is busy"), {
                    code: "ERR_SQLITE_ERROR",
                    errcode: 5,
                });
            }
            return "indexed";
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(attempts, 1);
        t.mock.timers.tick(50);
        assert.deepEqual(await resultPromise, {
            ok: true,
            value: "indexed",
            retryCount: 1,
        });
        assert.equal(attempts, 2);
        t.mock.timers.reset();
    });

    void it("prefers explicit result codes over a conflicting message", () => {
        assert.deepEqual(
            classifyIndexError({
                code: "SQLITE_BUSY",
                message: "disk I/O error",
            }),
            { category: "busy", retryable: true }
        );
    });
});
