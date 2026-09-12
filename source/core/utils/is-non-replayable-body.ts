import is from '@sindresorhus/is';

// A body is replayable only if iterating it again restarts from the beginning.
// Node streams, Web `ReadableStream`s, and iterator objects are consumed by an upload, so they cannot be replayed on a redirect or retry.
export default function isNonReplayableBody(body: unknown): boolean {
	// Creating an iterator can open resources or throw. Only create it when actually sending the body.
	return is.nodeStream(body)
		|| body instanceof ReadableStream
		|| (is.object(body) && is.function((body as Partial<Iterator<unknown>>).next));
}
