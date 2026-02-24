import type {ClientRequestArgs} from 'node:http';
import is from '@sindresorhus/is';

export default function getBodySize(body: unknown, headers: ClientRequestArgs['headers']): number | undefined {
	if (headers && 'content-length' in headers) {
		return Number(headers['content-length']);
	}

	if (!body) {
		return 0;
	}

	if (is.string(body)) {
		return new TextEncoder().encode(body).byteLength;
	}

	if (is.buffer(body)) {
		return body.length;
	}

	if (is.typedArray(body)) {
		return (body as ArrayBufferView).byteLength;
	}

	return undefined;
}
