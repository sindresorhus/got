import http = require('http');

export function init() {
    const requests: Array<() => void> = [];

    return {
        request(...args: any[]) {
            // @ts-ignore
            const req = http.request(...args);
            req.setTimeout = (_, timeout) => {
                requests.push(timeout);
            }
            return req;
        },
        forceTimeout() {
            for (const timeout of requests) {
                timeout()
            }
        }
    }
}
