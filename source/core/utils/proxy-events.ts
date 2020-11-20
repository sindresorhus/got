import {EventEmitter} from 'events';

type Fn = (...args: unknown[]) => void;
type Fns = Record<string, Fn>;

export default function (from: EventEmitter, to: EventEmitter, events: string[]): () => void {
	const eventFunctions: Fns = {};

	for (const event of events) {
		const eventFunction = (...args: unknown[]) => {
			to.emit(event, ...args);
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
