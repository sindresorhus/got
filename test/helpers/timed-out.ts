import http = require('http');

export function init() {
    const timeoutMap = new Map<string, Array<{
        delay: number;
        timeout: (delay: number, type: string) => void;
    }>>();

    return {
        request(...args: any[]) {
            // @ts-ignore
            const req = http.request(...args);
            req.addTimeout = (delay, fn, type) => {
                const timeouts = timeoutMap.get(type) || [];
                if (!timeoutMap.has(type)) {
                    timeoutMap.set(type, timeouts);
                }

                const timeoutObject = {
                    delay,
                    timeout: fn,
                };

                timeouts.push(timeoutObject);
                return () => {
                    timeouts.splice(timeouts.indexOf(timeoutObject), 1);
                };
            };
            return req;
        },
        tickTimers(ms: number) {
            for (const [type, timeouts] of timeoutMap.entries()) {
                for (const {delay, timeout} of timeouts) {
                    if (ms >= delay) {
                        timeout(delay, type)
                    }
                }
            }
        },
        forceTimeout(type: string) {
            const timeouts = timeoutMap.get(type);
            if (!timeouts) {
                throw new Error(`No timeouts registered for: '${type}'`)
            }

            for (const {delay, timeout} of timeouts) {
                timeout(delay, type)
            }
        },
    }
}
