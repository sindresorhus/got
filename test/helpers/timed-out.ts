import http = require('http');
import lolex = require('lolex');

export function init() {
    const clock = lolex.createClock();
    let requestWasCreated = false;

    return {
        request(...args: any[]) {
            requestWasCreated = true;

            // @ts-ignore
            const req = http.request(...args);
            req.timers = clock;
            req.setTimeout = (delay, timeout) => {
                req.on('socket', socket => {
                    let timer
                    function updateTimer() {
                        clock.clearTimeout(timer)
                        clock.setTimeout(timeout, delay)
                    }
                    updateTimer()

                    socket.on('data', () => updateTimer())

                    const write = socket.write
                    socket.write = (...args) => {
                        updateTimer()
                        return write.apply(socket, args)
                    }
                });
            };
            return req;
        },
        tickTimers(ms: number) {
            if (!requestWasCreated) {
                throw new Error(`Cannot tick got instance - no request was ever created`);
            }
            clock.tick(ms);
        },
    }
}
