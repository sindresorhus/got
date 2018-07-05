import test from 'ava';
import got from '../source';

test.serial('clear the progressInterval if the socket has been destroyed', async t => {
	const handlesComingFromAVA = 2;
	const err = await t.throws(got(`http://127.0.0.1:55555`, {retry: 0}));
	t.is(process._getActiveHandles().length - handlesComingFromAVA, 2);
	t.is(err.code, 'ECONNREFUSED');
});
