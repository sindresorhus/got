import {once} from 'node:events';

/**
Waits for an event and resolves with its first argument.

`once` resolves with the args array, which is the wrong shape for the many places that want the
emitted value itself. This unwraps the first argument so those call sites read the same as they did
with `pEvent`.
*/
export async function onceValue<T = any>(emitter: NodeJS.EventEmitter, name: string): Promise<T> {
	const [value] = await once(emitter, name) as [T];
	return value;
}

export default onceValue;
