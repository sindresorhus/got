import type {EventEmitter} from 'node:events';

type AnyFunction = (...arguments_: unknown[]) => void;
type Functions = Record<string, AnyFunction>;

export default function proxyEvents(from: EventEmitter, to: EventEmitter, events: Readonly<string[]>): () => void {
	const eventFunctions: Functions = {};

	for (const event of events) {
		const eventFunction = (...arguments_: unknown[]) => {
			to.emit(event, ...arguments_);
		};

		eventFunctions[event] = eventFunction;

		from.on(event, eventFunction);
	}

	return () => {
		for (const [event, eventFunction] of Object.entries(eventFunctions)) {
			from.off(event, eventFunction);
		}
	};
}
