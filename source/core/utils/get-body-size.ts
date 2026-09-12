import type {ClientRequestArgs} from 'node:http';
import is from '@sindresorhus/is';
import {stringToUint8Array} from 'uint8array-extras';

export default function getBodySize(body: unknown, headers: ClientRequestArgs['headers']): number | undefined {
	if (headers && 'content-length' in headers && headers['content-length'] !== undefined) {
		return Number(headers['content-length']);
	}

	if (!body) {
		return 0;
	}

	if (is.string(body)) {
		return stringToUint8Array(body).byteLength;
	}

	if (ArrayBuffer.isView(body)) {
		return body.byteLength;
	}

	return undefined;
}
