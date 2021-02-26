import {Readable, Writable} from 'stream';

export default function applyDestroyPatch(stream: Readable | Writable): void {
	const kDestroy = Symbol('destroy');

	if (Number(process.versions.node.split('.')[0]) >= 14) {
		return;
	}

	// @ts-expect-error
	stream[kDestroy] = stream.destroy;
	stream.destroy = (...args) => {
		if (!stream.destroyed) {
			// @ts-expect-error
			return stream[kDestroy](...args);
		}
	};
}
