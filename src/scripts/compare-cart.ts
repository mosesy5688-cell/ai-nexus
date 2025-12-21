/**
 * Compare Cart Client Script
 * 
 * B.14: Manages the comparison cart using localStorage
 * Separated from FloatingCompareBar.astro for CES compliance
 */

const CART_KEY = 'compareModels';
const MAX_MODELS = 5;

interface CartModel {
    id: string;
    name: string;
}

function getCart(): CartModel[] {
    try {
        return JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    } catch {
        return [];
    }
}

function saveCart(cart: CartModel[]) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateUI();
}

function removeFromCart(modelId: string) {
    const cart = getCart().filter(m => m.id !== modelId);
    saveCart(cart);
}

function clearCart() {
    localStorage.removeItem(CART_KEY);
    updateUI();
}

function updateUI() {
    const cart = getCart();
    const bar = document.getElementById('floating-compare-bar');
    const countEl = document.getElementById('compare-count');
    const listEl = document.getElementById('compare-models-list');
    const startBtn = document.getElementById('start-compare') as HTMLAnchorElement;

    if (!bar || !countEl || !listEl || !startBtn) return;

    // Show/hide bar
    bar.dataset.hidden = cart.length === 0 ? 'true' : 'false';

    // Update count
    countEl.textContent = cart.length.toString();

    // Update models list
    listEl.innerHTML = cart.map(m => `
    <div class="model-chip" data-id="${m.id}">
      <span>${m.name}</span>
      <span class="remove-btn" data-model-id="${m.id}">×</span>
    </div>
  `).join('');

    // Update compare link
    const ids = cart.map(m => encodeURIComponent(m.id)).join(',');
    startBtn.href = `/compare?models=${ids}`;

    // Attach remove handlers
    listEl.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const modelId = (btn as HTMLElement).dataset.modelId;
            if (modelId) removeFromCart(modelId);
        });
    });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    updateUI();

    // Clear button
    document.getElementById('clear-compare')?.addEventListener('click', clearCart);

    // Listen for storage changes (cross-tab sync)
    window.addEventListener('storage', (e) => {
        if (e.key === CART_KEY) updateUI();
    });

    // Listen for custom add events
    window.addEventListener('compare:add', updateUI);
});

// Expose for external use
(window as any).compareCart = {
    add: (id: string, name: string): boolean => {
        const cart = getCart();
        if (cart.length >= MAX_MODELS) {
            alert(`Maximum ${MAX_MODELS} models for comparison`);
            return false;
        }
        if (!cart.find(m => m.id === id)) {
            cart.push({ id, name });
            saveCart(cart);
            window.dispatchEvent(new CustomEvent('compare:add'));
        }
        return true;
    },
    remove: removeFromCart,
    clear: clearCart,
    get: getCart
};
