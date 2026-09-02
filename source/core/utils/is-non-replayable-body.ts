import is from '@sindresorhus/is';

// A body is replayable only if iterating it again restarts from the beginning.
// Node streams, Web `ReadableStream`s, generators, and self-iterating (one-shot) iterators all yield their data only once, so they cannot be replayed on a redirect or retry.
export default function isNonReplayableBody(body: unknown): boolean {
	return is.nodeStream(body)
		|| body instanceof ReadableStream
		|| is.generator(body)
		|| (is.asyncIterable(body) && (body[Symbol.asyncIterator]() as unknown) === body)
		|| (is.iterable(body) && (body[Symbol.iterator]() as unknown) === body);
}
