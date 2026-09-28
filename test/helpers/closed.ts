/**
Waits for an emitter to close, ignoring any error it emits along the way.

`once(emitter, 'close')` rejects when the emitter emits `error` first, and it has no option to opt
out. These two tests assert on the close event alone, so they need the wait without the rejection.
*/
export default function closed(emitter: NodeJS.EventEmitter): Promise<unknown[]> {
	return new Promise(resolve => {
		emitter.once('close', (...arguments_: unknown[]) => {
			resolve(arguments_);
		});
	});
}
