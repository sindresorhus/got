import {Buffer} from 'node:buffer';
import type {ClientRequestArgs} from 'node:http';
import is from '@sindresorhus/is';

export default function getBodySize(body: unknown, headers: ClientRequestArgs['headers']): number | undefined {
	if (headers && 'content-length' in headers && headers['content-length'] !== undefined) {
		return Number(headers['content-length']);
	}

	if (!body) {
		return 0;
	}

	if (is.string(body)) {
		return Buffer.byteLength(body);
	}

	return ArrayBuffer.isView(body) ? body.byteLength : undefined;
}
