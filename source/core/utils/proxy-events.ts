import type {EventEmitter} from 'node:events';

export default function proxyEvents(from: EventEmitter, to: EventEmitter, events: readonly string[]): () => void {
	const eventFunctions = new Map<string, (...arguments_: unknown[]) => void>();

	for (const event of events) {
		const eventFunction = (...arguments_: unknown[]) => {
			to.emit(event, ...arguments_);
		};

		eventFunctions.set(event, eventFunction);
		from.on(event, eventFunction);
	}

	return () => {
		for (const [event, eventFunction] of eventFunctions) {
			from.off(event, eventFunction);
		}
	};
}
