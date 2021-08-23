[> Back to homepage](../readme.md#documentation)

### Capturing async stack traces

**Caution:**
> - Capturing async stack traces can severely degrade performance!

**Want to skip the article? See the [Conclusion](#conclusion) where we discuss a mediocre solution.**

We live in a world full of bugs. Software is getting more and more complicated, which makes debugging increasingly more difficult. Ever had an error with no idea where it came from? Yeah, it's often not easy to track this down.

You might have noticed that the `.stack` of an error sometimes look incomplete. This is often due to the execution of an async function that is triggered by a timer. Following the example:

```js
await new Promise((resolve, reject) => {
	setTimeout(() => {
		reject(new Error('here'));
	});
});
```

```js
file:///home/szm/Desktop/got/demo.js:3
                reject(new Error('here'));
                       ^

Error: here
    at Timeout._onTimeout (file:///home/szm/Desktop/got/demo.js:3:10)
    at listOnTimeout (node:internal/timers:557:17)
    at processTimers (node:internal/timers:500:7)
```

The stack trace does not show where the timeout was set. It's currently not possible to determine this with the native `Promise`s. However, [`bluebird`](https://github.com/petkaantonov/bluebird/) exposes an option dedicated to capturing async stack traces:

```js
import Bluebird from 'bluebird';

Bluebird.config({longStackTraces: true});
global.Promise = Bluebird;

await new Promise((resolve, reject) => {
	setTimeout(() => {
		reject(new Error('here'));
	});
});
```

```
node:internal/process/esm_loader:74
    internalBinding('errors').triggerUncaughtException(
                              ^

Error: here
    at Timeout._onTimeout (file:///home/szm/Desktop/got/demo.js:7:10)
    at listOnTimeout (node:internal/timers:557:17)
    at processTimers (node:internal/timers:500:7)
From previous event:
    at file:///home/szm/Desktop/got/demo.js:5:7
    at ModuleJob.run (node:internal/modules/esm/module_job:183:25)
    at async Loader.import (node:internal/modules/esm/loader:178:24)
    at async Object.loadESM (node:internal/process/esm_loader:68:5)
    at async handleMainPromise (node:internal/modules/run_main:63:12)
```

Now it's clear. We know that the timeout was set on line 5. Bluebird should be sufficient for Got:

```js
import Bluebird from 'bluebird';
import got from 'got';

Bluebird.config({longStackTraces: true});
global.Promise = Bluebird;

try {
	await got('https://httpbin.org/delay/1', {
		timeout: {
			request: 1
		},
		retry: {
			limit: 0
		}
	});
} catch (error) {
	console.error(error.stack);
}
```

```
TimeoutError: Timeout awaiting 'request' for 1ms
    at ClientRequest.<anonymous> (file:///home/szm/Desktop/got/dist/source/core/index.js:780:61)
    at Object.onceWrapper (node:events:514:26)
    at ClientRequest.emit (node:events:406:35)
    at TLSSocket.socketErrorListener (node:_http_client:447:9)
    at TLSSocket.emit (node:events:394:28)
    at emitErrorNT (node:internal/streams/destroy:157:8)
    at emitErrorCloseNT (node:internal/streams/destroy:122:3)
    at processTicksAndRejections (node:internal/process/task_queues:83:21)
    at Timeout.timeoutHandler [as _onTimeout] (file:///home/szm/Desktop/got/dist/source/core/timed-out.js:42:25)
    at listOnTimeout (node:internal/timers:559:11)
    at processTimers (node:internal/timers:500:7)
From previous event:
    at new PCancelable (file:///home/szm/Desktop/got/node_modules/p-cancelable/index.js:31:19)
    at asPromise (file:///home/szm/Desktop/got/dist/source/as-promise/index.js:21:21)
    at lastHandler (file:///home/szm/Desktop/got/dist/source/create.js:42:27)
    at iterateHandlers (file:///home/szm/Desktop/got/dist/source/create.js:49:28)
    at got (file:///home/szm/Desktop/got/dist/source/create.js:69:16)
    at file:///home/szm/Desktop/got/demo.js:8:8
    at ModuleJob.run (node:internal/modules/esm/module_job:183:25)
    at async Loader.import (node:internal/modules/esm/loader:178:24)
    at async Object.loadESM (node:internal/process/esm_loader:68:5)
    at async handleMainPromise (node:internal/modules/run_main:63:12)
```

As expected, we know where the timeout has been set. Unfortunately, if we increase our retry count limit to `1`, the stack trace remains the same. That's because `bluebird` doesn't track I/O events. Please note that this should be sufficient for most cases. In order to debug further, we can use [`async_hooks`](https://nodejs.org/api/async_hooks.html) instead. A Stack Overflow user has come up with an awesome solution:

```js
import asyncHooks from 'async_hooks';

const traces = new Map();

asyncHooks.createHook({
	init(id) {
		const trace = {};
		Error.captureStackTrace(trace);
		traces.set(id, trace.stack.replace(/(^.+$\n){4}/m, '\n'));
	},
	destroy(id) {
		traces.delete(id);
	},
}).enable();

globalThis.Error = class extends Error {
	constructor(message) {
		super(message);
		this.constructor.captureStackTrace(this, this.constructor);
	}

	static captureStackTrace(what, where) {
		super.captureStackTrace.call(Error, what, where);

		const trace = traces.get(asyncHooks.executionAsyncId());
		if (trace) {
			what.stack += trace;
		}
	}
};
```

If we replace the `bluebird` part with this, we get:

```
Error: Timeout awaiting 'request' for 1ms
    at ClientRequest.<anonymous> (file:///home/szm/Desktop/got/dist/source/core/index.js:780:61)
    at Object.onceWrapper (node:events:514:26)
    at ClientRequest.emit (node:events:406:35)
    at TLSSocket.socketErrorListener (node:_http_client:447:9)
    at TLSSocket.emit (node:events:394:28)
    at emitErrorNT (node:internal/streams/destroy:157:8)
    at emitErrorCloseNT (node:internal/streams/destroy:122:3)
    at processTicksAndRejections (node:internal/process/task_queues:83:21)
    at emitInitScript (node:internal/async_hooks:493:3)
    at process.nextTick (node:internal/process/task_queues:133:5)
    at onDestroy (node:internal/streams/destroy:96:15)
    at TLSSocket.Socket._destroy (node:net:677:5)
    at _destroy (node:internal/streams/destroy:102:25)
    at TLSSocket.destroy (node:internal/streams/destroy:64:5)
    at ClientRequest.destroy (node:_http_client:371:16)
    at emitInitScript (node:internal/async_hooks:493:3)
    at initAsyncResource (node:internal/timers:162:5)
    at new Timeout (node:internal/timers:196:3)
    at setTimeout (node:timers:164:19)
    at addTimeout (file:///home/szm/Desktop/got/dist/source/core/timed-out.js:32:25)
    at timedOut (file:///home/szm/Desktop/got/dist/source/core/timed-out.js:59:31)
    at Request._onRequest (file:///home/szm/Desktop/got/dist/source/core/index.js:771:32)
    at emitInitScript (node:internal/async_hooks:493:3)
    at promiseInitHook (node:internal/async_hooks:323:3)
    at promiseInitHookWithDestroyTracking (node:internal/async_hooks:327:3)
    at Request.flush (file:///home/szm/Desktop/got/dist/source/core/index.js:274:24)
    at makeRequest (file:///home/szm/Desktop/got/dist/source/as-promise/index.js:125:30)
    at Request.<anonymous> (file:///home/szm/Desktop/got/dist/source/as-promise/index.js:121:17)
    at Object.onceWrapper (node:events:514:26)
    at emitInitScript (node:internal/async_hooks:493:3)
    at promiseInitHook (node:internal/async_hooks:323:3)
    at promiseInitHookWithDestroyTracking (node:internal/async_hooks:327:3)
    at file:///home/szm/Desktop/got/dist/source/core/index.js:357:27
    at processTicksAndRejections (node:internal/process/task_queues:96:5)
    at emitInitScript (node:internal/async_hooks:493:3)
    at promiseInitHook (node:internal/async_hooks:323:3)
    at promiseInitHookWithDestroyTracking (node:internal/async_hooks:327:3)
    at file:///home/szm/Desktop/got/dist/source/core/index.js:338:50
    at Request._beforeError (file:///home/szm/Desktop/got/dist/source/core/index.js:388:11)
    at ClientRequest.<anonymous> (file:///home/szm/Desktop/got/dist/source/core/index.js:781:18)
    at Object.onceWrapper (node:events:514:26)
    at emitInitScript (node:internal/async_hooks:493:3)
    at process.nextTick (node:internal/process/task_queues:133:5)
    at onDestroy (node:internal/streams/destroy:96:15)
    at TLSSocket.Socket._destroy (node:net:677:5)
    at _destroy (node:internal/streams/destroy:102:25)
    at TLSSocket.destroy (node:internal/streams/destroy:64:5)
    at ClientRequest.destroy (node:_http_client:371:16)
    at emitInitScript (node:internal/async_hooks:493:3)
    at initAsyncResource (node:internal/timers:162:5)
    at new Timeout (node:internal/timers:196:3)
    at setTimeout (node:timers:164:19)
    at addTimeout (file:///home/szm/Desktop/got/dist/source/core/timed-out.js:32:25)
    at timedOut (file:///home/szm/Desktop/got/dist/source/core/timed-out.js:59:31)
    at Request._onRequest (file:///home/szm/Desktop/got/dist/source/core/index.js:771:32)
    at emitInitScript (node:internal/async_hooks:493:3)
    at promiseInitHook (node:internal/async_hooks:323:3)
    at promiseInitHookWithDestroyTracking (node:internal/async_hooks:327:3)
    at Request.flush (file:///home/szm/Desktop/got/dist/source/core/index.js:274:24)
    at lastHandler (file:///home/szm/Desktop/got/dist/source/create.js:37:26)
    at iterateHandlers (file:///home/szm/Desktop/got/dist/source/create.js:49:28)
    at got (file:///home/szm/Desktop/got/dist/source/create.js:69:16)
    at Timeout.timeoutHandler [as _onTimeout] (file:///home/szm/Desktop/got/dist/source/core/timed-out.js:42:25)
    at listOnTimeout (node:internal/timers:559:11)
    at processTimers (node:internal/timers:500:7)
```

This is extremely long, and not a complete Node.js app. Just a demo. Imagine how long it would be if this was used with databases, file systems, etc.

#### Conclusion

All these workarounds have a large impact on performance. However, there is a possible solution to this madness. Got provides handlers, hooks, and context. We can capture the stack trace in a handler, store it in a context and expose it in a `beforeError` hook.

```js
import got from 'got';

const instance = got.extend({
	handlers: [
		(options, next) => {
			Error.captureStackTrace(options.context);
			return next(options);
		}
	],
	hooks: {
		beforeError: [
			error => {
				error.source = error.options.context.stack.split('\n');
				return error;
			}
		]
	}
});

try {
	await instance('https://httpbin.org/delay/1', {
		timeout: {
			request: 100
		},
		retry: {
			limit: 0
		}
	});
} catch (error) {
	console.error(error);
}
```

```
RequestError: Timeout awaiting 'request' for 100ms
    at ClientRequest.<anonymous> (file:///home/szm/Desktop/got/dist/source/core/index.js:780:61)
    at Object.onceWrapper (node:events:514:26)
    at ClientRequest.emit (node:events:406:35)
    at TLSSocket.socketErrorListener (node:_http_client:447:9)
    at TLSSocket.emit (node:events:394:28)
    at emitErrorNT (node:internal/streams/destroy:157:8)
    at emitErrorCloseNT (node:internal/streams/destroy:122:3)
    at processTicksAndRejections (node:internal/process/task_queues:83:21)
    at Timeout.timeoutHandler [as _onTimeout] (file:///home/szm/Desktop/got/dist/source/core/timed-out.js:42:25)
    at listOnTimeout (node:internal/timers:559:11)
    at processTimers (node:internal/timers:500:7) {
  input: undefined,
  code: 'ETIMEDOUT',
  timings: { <too long to include> },
  name: 'TimeoutError',
  options: { <too long to include> },
  event: 'request',
  source: [
    'Error',
    '    at got.extend.handlers (file:///home/szm/Desktop/got/demo.js:6:10)',
    '    at iterateHandlers (file:///home/szm/Desktop/got/dist/source/create.js:49:28)',
    '    at got (file:///home/szm/Desktop/got/dist/source/create.js:69:16)',
    '    at file:///home/szm/Desktop/got/demo.js:23:8',
    '    at ModuleJob.run (node:internal/modules/esm/module_job:183:25)',
    '    at async Loader.import (node:internal/modules/esm/loader:178:24)',
    '    at async Object.loadESM (node:internal/process/esm_loader:68:5)',
    '    at async handleMainPromise (node:internal/modules/run_main:63:12)'
  ]
}
```

Yay! This is much more readable. Furthermore, we capture the stack trace only when `got` is called. This is definitely going to have some performance impact, but it will be much more performant than the other mentioned solutions.

Curious to know more? Check out these links:
- https://stackoverflow.com/questions/54914770/is-there-a-good-way-to-surface-error-traces-in-production-across-event-emitters
- https://github.com/nodejs/node/issues/11370
- https://github.com/puppeteer/puppeteer/issues/2037
- https://github.com/nodejs/node/pull/13870
