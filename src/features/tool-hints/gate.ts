/**
 * Admission control for a hint rule.
 *
 * The first version fired each rule once per session. That was wrong for a
 * reason compaction makes obvious: `fired` lives in extension memory, so it
 * survives compaction, while the hint itself lives in a tool result that the
 * summariser replaces. An ignored hint therefore became *permanently* silent --
 * in a 300-call session where an agent writes the same `sed -n` view forty
 * times, the one hint it saw at call 20 could never come back, and nothing
 * recorded that it had been ignored nineteen times since.
 *
 * The policy here is deliberately asymmetric:
 *
 *  - re-offering is cheap and bounded: after `rearmAfter` suppressed matches the
 *    rule may speak again, up to `maxFires` per session;
 *  - not re-offering is expensive and unbounded: the agent keeps using the
 *    worse tool for the rest of the session.
 *
 * Suppression is counted, not merely dropped, so a rule that fires and converts
 * nobody is visible in the session entries rather than invisible.
 */

export interface GateOptions {
    /** Fires allowed per key before the rule goes quiet for good. */
    maxFires?: number;
    /** Suppressed matches tolerated before the rule speaks again. */
    rearmAfter?: number;
}

/** Fire, then re-offer twice more if the agent keeps repeating the pattern. */
export const DEFAULT_MAX_FIRES = 3;

/** Nine repetitions is a pattern, not a slip of the hand. */
export const DEFAULT_REARM_AFTER = 8;

export interface FireDecision {
    fire: boolean;
    /** True when this call was suppressed rather than fired, for the counter. */
    suppressed: boolean;
    /**
     * Why the decision went the way it did, for the session record:
     * `first` and `rearm` fire, `pending` and `capped` suppress.
     */
    reason: "first" | "rearm" | "pending" | "capped";
    /** Fires so far for this key, after this decision. */
    fires: number;
    /** Suppressed matches since the last fire. */
    sinceFire: number;
}

export class HintGate {
    private readonly maxFires: number;
    private readonly rearmAfter: number;
    private readonly fires = new Map<string, number>();
    private readonly pending = new Map<string, number>();

    constructor(options: GateOptions = {}) {
        this.maxFires = options.maxFires ?? DEFAULT_MAX_FIRES;
        this.rearmAfter = options.rearmAfter ?? DEFAULT_REARM_AFTER;
    }

    /**
     * Whether this match should produce a hint.
     *
     * A key that has never fired speaks immediately: the first occurrence is the
     * one most likely to be a genuine misunderstanding of the tool set.
     */
    offer(key: string): FireDecision {
        const fires = this.fires.get(key) ?? 0;
        const sinceFire = this.pending.get(key) ?? 0;

        if (fires === 0) {
            this.fires.set(key, 1);
            this.pending.set(key, 0);
            return {
                fire: true,
                suppressed: false,
                reason: "first",
                fires: 1,
                sinceFire: 0,
            };
        }
        if (fires >= this.maxFires) {
            return {
                fire: false,
                suppressed: true,
                reason: "capped",
                fires,
                sinceFire,
            };
        }

        const nextSince = sinceFire + 1;
        if (nextSince <= this.rearmAfter) {
            this.pending.set(key, nextSince);
            return {
                fire: false,
                suppressed: true,
                reason: "pending",
                fires,
                sinceFire: nextSince,
            };
        }

        this.fires.set(key, fires + 1);
        this.pending.set(key, 0);
        return {
            fire: true,
            suppressed: false,
            reason: "rearm",
            fires: fires + 1,
            sinceFire: 0,
        };
    }

    /** How many times this key has fired, for the session record. */
    fireCount(key: string): number {
        return this.fires.get(key) ?? 0;
    }

    reset(): void {
        this.fires.clear();
        this.pending.clear();
    }
}
