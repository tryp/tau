# Background-task maintenance

Pi-tau defers session restore and maintenance (orphan scans, run-directory
sweeps, and sidecar purges) so they do not block extension loading or
`session_start`. Maintenance timers are unref'd and do not keep pi alive.

The orphan-chain scan and stale run-directory sweep first run after a default
5-second delay. Set `PI_TAU_ORPHAN_REAPER_DELAY_MS` to a non-negative delay in
milliseconds (including zero), or set `PI_TAU_DISABLE_ORPHAN_REAPER=1` to skip orphan
scans entirely. The existing `PI_TAU_ENABLE_ORPHAN_REAPER=1` opt-in remains
required before any orphan process can be killed; disabling the scan does not
change that safety gate.
