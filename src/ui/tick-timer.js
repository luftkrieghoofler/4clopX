// Anchor the stock countdown to server-provided remaining time, not the
// number of timer callbacks the browser happens to run in a background tab.
export function createTickTimer(doc, pageWindow, now = Date.now) {
    let deadline = null;
    let latestAt = -Infinity;
    let timer = null;
    let installed = false;

    function render() {
        pageWindow.clearTimeout(timer);
        const node = doc.querySelector('#countdown');
        if (!node) return;
        const seconds = Math.max(0, Math.ceil((deadline - now()) / 1000));
        node.textContent = seconds === 0 ? 'NOW!' :
            `${Math.floor(seconds / 3600)}:` +
            `${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:` +
            String(seconds % 60).padStart(2, '0');
        // Do not invent a new tick deadline once this one passes: await
        // the next server snapshot (also conservative for safety warnings).
        timer = pageWindow.setTimeout(render, 1000);
    }

    return (snapshot) => {
        if (!snapshot || !Number.isFinite(snapshot.tickSeconds) || snapshot.tickSeconds < 0
            || !Number.isFinite(snapshot.at) || snapshot.at < latestAt
            || !doc.querySelector('#countdown')) return;
        deadline = snapshot.at + snapshot.tickSeconds * 1000;
        latestAt = snapshot.at;
        if (!installed) {
            // The stock loop queues string callbacks to doCountdownTick(N).
            // Redirect its outstanding callback too, ignoring that stale N.
            // render clears our timer so this cannot start a second loop.
            pageWindow.doCountdownTick = render;
            doc.addEventListener('visibilitychange', render);
            installed = true;
        }
        render();
    };
}
