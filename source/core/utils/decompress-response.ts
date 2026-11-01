import zlib from 'node:zlib';
import type {IncomingMessage} from 'node:http';
import decompressResponse from 'decompress-response';

const supportedEncodings = new Set(['gzip', 'deflate', 'br', ...(typeof zlib.createZstdDecompress === 'function' ? ['zstd'] : [])]);

// Node.js `fetch` (undici) and curl cap chained content codings at five to prevent resource exhaustion.
// Got counts only codings that add a decoder, so `identity` and empty list elements do not count.
const maxContentEncodings = 5;

export default function decompressResponseBody(response: IncomingMessage): IncomingMessage {
	const encodings = (response.headers['content-encoding'] ?? '')
		.toLowerCase()
		.split(',')
		.map(encoding => encoding.trim())
		// Empty list elements are ignored (RFC 9110, section 5.6.1.2).
		.filter(encoding => encoding.length > 0)
		// `identity` means the content was not transformed, so it adds no decoding step.
		.filter(encoding => encoding !== 'identity')
		.map(encoding => encoding === 'x-gzip' ? 'gzip' : encoding);
	if (encodings.some(encoding => !supportedEncodings.has(encoding))) {
		return decompressResponse(response);
	}

	// Each coding adds a wrapper stream, so an excessive list can exhaust resources.
	if (encodings.length > maxContentEncodings) {
		throw new Error(`Too many content codings in the response: ${encodings.length}. The maximum is ${maxContentEncodings}.`);
	}

	// Content-Encoding lists codings in application order (RFC 9110, section 8.4).
	for (const encoding of encodings.toReversed()) {
		const source = response;
		const originalHeaders = source.headers;
		try {
			// The dependency accepts one coding. Retain the native headers for wire-byte validation.
			source.headers = {...originalHeaders, 'content-encoding': encoding};
			response = decompressResponse(source);
		} finally {
			source.headers = originalHeaders;
		}

		const decoded = response;
		decoded.once('close', () => {
			source.destroy();
		});

		source.once('error', error => {
			decoded.destroy(error);
		});
	}

	return response;
}
