import {EventEmitter} from 'events';

type Fn = (...args: unknown[]) => void;
type Fns = Record<string, Fn>;

export default function (from: EventEmitter, to: EventEmitter, events: string[]): () => void {
	const fns: Fns = {};

	for (const event of events) {
		fns[event] = (...args: unknown[]) => {
			to.emit(event, ...args);
		};

		from.on(event, fns[event]);
	}

	return () => {
		for (const event of events) {
			from.off(event, fns[event]);
		}
	};
}
