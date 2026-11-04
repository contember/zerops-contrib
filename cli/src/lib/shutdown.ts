/**
 * Lets a command that holds remote state (a tunnel's VPN key) clean up when stdout is closed.
 * index.ts exits on EPIPE, which is right for a listing piped into `head`, but would skip a
 * pending teardown; while `onBrokenPipe` is set, it is called instead.
 */
export const shutdown: { onBrokenPipe?: () => void } = {};
