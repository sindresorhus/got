import zlib from 'node:zlib';
import type {IncomingMessage} from 'node:http';
import decompressResponse from 'decompress-response';

const supportedEncodings = new Set(['gzip', 'deflate', 'br', ...(typeof zlib.createZstdDecompress === 'function' ? ['zstd'] : [])]);

export default function decompressResponseBody(response: IncomingMessage): IncomingMessage {
	const encodings = (response.headers['content-encoding'] ?? '')
		.toLowerCase()
		.split(',')
		.map(encoding => encoding.trim())
		// Empty list members are ignored (RFC 9110, section 5.6.1.1).
		.filter(encoding => encoding.length > 0)
		// `identity` means the content was not transformed, so it adds no decoding step.
		.filter(encoding => encoding !== 'identity')
		.map(encoding => encoding === 'x-gzip' ? 'gzip' : encoding);
	if (encodings.some(encoding => !supportedEncodings.has(encoding))) {
		return decompressResponse(response);
	}

	const nativeResponse = response;
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

		if (source === nativeResponse) {
			continue;
		}

		const decoded = response;
		source.once('error', error => {
			decoded.destroy(error);
		});
	}

	return response;
}
