// eslint-disable-next-line ava/use-test
import {ExecutionContext} from 'ava';

export default function invalidUrl(t: ExecutionContext, error: TypeError & NodeJS.ErrnoException, url: string) {
	t.is(error.code, 'ERR_INVALID_URL');

	if (error.message === 'Invalid URL') {
		t.is((error as any).input, url);
	} else {
		t.is(error.message.slice('Invalid URL: '.length), url);
	}
}
