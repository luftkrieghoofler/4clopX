// Rewrites the "Capitalism" dropdown on every page: the dynamic marketplace
// UI handles the sell and buy sides with client-side tabs, so the separate
// "Buyer's ... Marketplace" entries are redundant.  Runs on all pages (the
// navbar is rendered by header.php everywhere).
export const navbarModule = {
    name: 'navbar',

    matches: () => true,

    init() {
        const nav = document.querySelector('nav.navbar');
        if (!nav) return;
        for (const a of nav.querySelectorAll('a[href^="buyermarketplace.php"]')) {
            const li = a.closest('li');
            if (li) li.remove();
        }
        // "Resources Marketplace" -> "Marketplace"; the weapons/armor labels
        // ("Weapons Marketplace", "Armor Marketplace") already read fine.
        for (const a of nav.querySelectorAll('a[href="marketplace.php"]')) {
            a.textContent = 'Marketplace';
        }
    },
};
