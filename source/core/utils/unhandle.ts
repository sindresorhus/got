import type {EventEmitter} from 'node:events';

type Origin = EventEmitter;
type Event = string | symbol;
type AnyFunction = (...arguments_: any[]) => void;

type Handler = {
	origin: Origin;
	event: Event;
	fn: AnyFunction;
};

type Unhandler = {
	once: (origin: Origin, event: Event, function_: AnyFunction) => void;
	unhandleAll: () => void;
};

// When attaching listeners, it's very easy to forget about them.
// Especially if you do error handling and set timeouts.
// So instead of checking if it's proper to throw an error on every timeout ever,
// use this simple tool which will remove all listeners you have attached.
export default function unhandle(): Unhandler {
	const handlers: Handler[] = [];

	return {
		once(origin: Origin, event: Event, function_: AnyFunction) {
			origin.once(event, function_);
			handlers.push({origin, event, fn: function_});
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
