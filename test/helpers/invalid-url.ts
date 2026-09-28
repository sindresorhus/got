import assert from 'node:assert/strict';

export default function invalidUrl(error: TypeError & NodeJS.ErrnoException, url: string) {
	assert.equal(error.code, 'ERR_INVALID_URL');

	if (error.message === 'Invalid URL') {
		assert.equal((error as any).input, url);
	} else {
		assert.equal(error.message.slice('Invalid URL: '.length), url);
	}
}
