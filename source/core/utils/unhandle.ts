import {EventEmitter} from 'events';

type Origin = EventEmitter;
type Event = string | symbol;
type Fn = (...args: any[]) => void;

interface Handler {
	origin: Origin;
	event: Event;
	fn: Fn;
}

interface Unhandler {
	once: (origin: Origin, event: Event, fn: Fn) => void;
	unhandleAll: () => void;
}

// When attaching listeners, it's very easy to forget about them.
// Especially if you do error handling and set timeouts.
// So instead of checking if it's proper to throw an error on every timeout ever,
// use this simple tool which will remove all listeners you have attached.
export default function unhandle(): Unhandler {
	const handlers: Handler[] = [];

	return {
		once(origin: Origin, event: Event, fn: Fn) {
			origin.once(event, fn);
			handlers.push({origin, event, fn});
		},

		unhandleAll() {
			for (const handler of handlers) {
				const {origin, event, fn} = handler;
				origin.removeListener(event, fn);
			}

			handlers.length = 0;
		},
	};
}
