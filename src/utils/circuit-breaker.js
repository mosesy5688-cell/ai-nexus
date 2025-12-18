/**
 * Circuit Breaker Utility
 * Constitution V4.3.2 Resilience Pattern
 */
export class CircuitBreaker {
    constructor(config = {}) {
        this.maxFailures = config.maxFailures || 5;
        this.cooldownMs = config.cooldownMs || 60000;
        this.halfOpenRequests = config.halfOpenRequests || 3;

        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.failures = 0;
        this.lastFailure = null;
        this.successesInHalfOpen = 0;
    }

    isOpen() {
        if (this.state === 'CLOSED') return false;

        if (this.state === 'OPEN') {
            const timeSinceLastFailure = Date.now() - this.lastFailure;
            if (timeSinceLastFailure >= this.cooldownMs) {
                this.state = 'HALF_OPEN';
                this.successesInHalfOpen = 0;
                console.log('[CircuitBreaker] State: HALF_OPEN');
                return false;
            }
            return true;
        }

        // HALF_OPEN state - allow limited requests
        return false; // Actually logic handled by recordSuccess/Failure but basic check passes
    }

    recordSuccess() {
        if (this.state === 'HALF_OPEN') {
            this.successesInHalfOpen++;
            if (this.successesInHalfOpen >= this.halfOpenRequests) {
                this.state = 'CLOSED';
                this.failures = 0;
                console.log('[CircuitBreaker] State: CLOSED (recovered)');
            }
        } else {
            this.failures = 0;
        }
    }

    recordFailure() {
        this.failures++;
        this.lastFailure = Date.now();

        if (this.state === 'HALF_OPEN') {
            this.state = 'OPEN';
            console.log('[CircuitBreaker] State: OPEN (half-open failed)');
        } else if (this.failures >= this.maxFailures) {
            this.state = 'OPEN';
            console.log('[CircuitBreaker] State: OPEN (max failures reached)');
        }
    }

    getStatus() {
        return {
            state: this.state,
            failures: this.failures,
            lastFailure: this.lastFailure,
            isOpen: this.isOpen()
        };
    }

    reset() {
        this.state = 'CLOSED';
        this.failures = 0;
        this.lastFailure = null;
        this.successesInHalfOpen = 0;
    }
}
