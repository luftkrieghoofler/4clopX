// Leases tolerate minute-scale background timer batching. A focused tab
// can take over immediately; no short verification timer must fire first.
export const LIVE_LEADER_TTL = 180000;
const FOCUS_TTL = 25000;

export function createLiveTab({ id, read, write, remove, focused, now = Date.now }) {
    function isLeader() { return read('leader')?.id === id; }
    function stampFocus() {
        if (focused()) write('focus', { id, at: now() });
        else if (read('focus')?.id === id) remove('focus');
    }
    function anyoneFocused() {
        const record = read('focus');
        return focused() || !!record && now() - record.at < FOCUS_TTL;
    }
    function maintain() {
        const record = read('leader');
        if (isLeader() || !record || now() - record.at >= LIVE_LEADER_TTL
            || (focused() && !record.focused)) {
            write('leader', { id, at: now(), focused: focused() });
        }
        return isLeader();
    }
    function release() {
        if (isLeader()) remove('leader');
        if (read('focus')?.id === id) remove('focus');
    }
    return { isLeader, stampFocus, anyoneFocused, maintain, release };
}
