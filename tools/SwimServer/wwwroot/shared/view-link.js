// Share-a-view links for the scope pages (ERAM, ASDE-X).
//
// A link is the current page URL with ?view=<base64url JSON>. The JSON is whatever
// the page hands to copy(): usually { ls: {localStorage snapshot}, ...page view state }.
// Opening the link runs takeFromUrl() before the page reads its own settings, which
// writes the snapshot back into localStorage and strips the param, so a refresh
// doesn't re-apply an old link over changes made since.
(function () {
    const PARAM = 'view';

    function toB64u(str) {
        let bin = '';
        for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function fromB64u(s) {
        let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    }

    window.ViewLink = {
        // Read and strip ?view= from the address bar. Returns the payload, or null.
        takeFromUrl() {
            try {
                const u = new URL(location.href);
                const raw = u.searchParams.get(PARAM);
                if (raw === null) return null;
                u.searchParams.delete(PARAM);
                history.replaceState(null, '', u.pathname + u.search + u.hash);
                return JSON.parse(fromB64u(raw));
            } catch (e) {
                console.warn('Ignoring bad view link:', e);
                return null;
            }
        },

        // Snapshot every localStorage entry whose key starts with one of the prefixes.
        collectLocal(prefixes) {
            const out = {};
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (prefixes.some(p => k.startsWith(p))) out[k] = localStorage.getItem(k);
                }
            } catch (e) { /* storage blocked: share what we have */ }
            return out;
        },

        // Write a localStorage snapshot back (values are the raw strings collectLocal read).
        restoreLocal(snapshot) {
            for (const [k, v] of Object.entries(snapshot || {})) {
                try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ }
            }
        },

        // Full URL for this page carrying payload.
        build(payload) {
            const u = new URL(location.href);
            u.search = '';
            u.hash = '';
            u.searchParams.set(PARAM, toB64u(JSON.stringify(payload)));
            return u.toString();
        },

        // Copy the link to the clipboard. Falls back to a prompt where the clipboard is
        // unavailable (plain-http pages, older browsers). Resolves true if copied.
        async copy(payload) {
            const url = this.build(payload);
            try {
                await navigator.clipboard.writeText(url);
                return true;
            } catch (e) {
                window.prompt('Copy this view link:', url);
                return false;
            }
        },
    };
})();
